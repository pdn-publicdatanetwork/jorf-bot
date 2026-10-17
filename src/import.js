// Import des mesures nominatives du JORF dans les tables \`ministres\` et
// \`cabinets_ministeriels\` (mêmes conventions d'identifiants que le pipeline
// webapp : MIN-<NOM>-<AAAAMMJJ>, CAB-…), suivi dans \`jorf_releves\`.

import { cleNom, releverJour } from "./jorf.js";
import { ecrire, lire, lirePrive, maj } from "./supabase.js";
import { notifierIndexNow } from "./indexnow.js";

const idMinistre = (nom, date) => `MIN-${nom.toUpperCase().replace(/[^A-Z]/g, "")}-${date.replace(/-/g, "")}`;
const idCabinet = (ministreId, prenom, nom) => `CAB-${ministreId}-${cleNom(prenom, nom).replace(/ /g, "-").toUpperCase()}`;

async function chercherParlementaire(prenom, nom) {
  const or = `(and(nom.ilike.${nom},prenom.ilike.${prenom}),and(nom.ilike.${prenom},prenom.ilike.${nom}))`;
  const rows = await lire("parlementaires", new URLSearchParams({ select: "personne_id", or, limit: "1" }));
  return rows[0]?.personne_id ?? null;
}

async function chercherCollaborateur(prenom, nom) {
  const rows = await lire("collaborateurs", new URLSearchParams({
    select: "collab_id,collab_prenom,collab_nom,collab_cle,slug", collab_cle: `eq.${cleNom(prenom, nom)}`, limit: "1",
  }));
  return rows[0] ?? null;
}

async function chercherMinistre(prenom, nom) {
  const or = `(and(nom.ilike.${nom},prenom.ilike.${prenom}),and(nom.ilike.${prenom},prenom.ilike.${nom}))`;
  const rows = await lire("ministres", new URLSearchParams({ select: "id", or, order: "debut.desc", limit: "1" }));
  return rows[0]?.id ?? null;
}

// Chargement en une fois de tous les mandats ministériels (mode corpus) :
// sert à rattacher un cabinet par portefeuille + date quand le décret ne
// nomme pas le ministre (« directeur de cabinet du ministre de l'intérieur »).
async function chargerMandats(ctx) {
  const rows = await lire("ministres", new URLSearchParams({
    select: "id,prenom,nom,portefeuille,debut,fin", limit: "2000",
  }));
  ctx.mandats = rows.map((m) => ({
    id: m.id, debut: m.debut, fin: m.fin,
    cleN: cleNom(m.prenom ?? "", m.nom ?? ""),
    cleP: cleNom((m.portefeuille ?? "").replace(/^ministre\s*/i, "")),
  }));
}

// Portefeuilles du JORF → libellés de la table ministres (alias connus).
// Clés normalisées par cleNom (le lookup se fait sur cles[0] normalisé).
const ALIAS_PORTEFEUILLE = {
  [cleNom("de la justice")]: [cleNom("garde des sceaux")],
  [cleNom("de la justice et des libertés")]: [cleNom("garde des sceaux")],
  [cleNom("des armées")]: [cleNom("de la défense")],
  [cleNom("de la défense")]: [cleNom("des armées")],
  [cleNom("des affaires étrangères")]: [cleNom("des affaires étrangères et du développement international")],
};

// Nettoie un portefeuille extrait d'un décret : retire les préfixes
// « délégué(e) (auprès) du ministre… » pour garder le portefeuille utile.
function normaliserPortefeuille(p) {
  let s = (p ?? "").trim();
  // « … auprès du/de la ministre de l'économie » → « de l'économie »
  const m = /aupr[eè]s (?:du|de la|de l|des) (?:premier ministre|ministre|ministre d[e']état|secrétaire d'état)\b(.*)$/i.exec(s);
  if (m) {
    s = (/premier ministre/i.test(s) ? "Premier ministre" : "") + m[1].trim();
  }
  // « délégué(e) auprès de… » résiduel
  s = s.replace(/^d[eé]l[eé]gu[eé]e?\s*/i, "").replace(/^charg[eé]e?\s*/i, "").trim();
  return s;
}

// Mandat en fonction à la date donnée pour un portefeuille (clé normalisée).
// Retient le mandat le plus récent ; idem sur le nom si un nom est fourni.
function mandaterParPortefeuille(ctx, portefeuille, date) {
  const cles = [cleNom(normaliserPortefeuille(portefeuille).replace(/^ministre\s*/i, ""))];
  // alias (justice → garde des sceaux, armées → défense…)
  const alias = ALIAS_PORTEFEUILLE[cles[0]] ?? [];
  for (const a of alias) cles.push(cleNom(a));
  if (!cles[0] || !ctx.mandats) return null;
  const candidats = ctx.mandats.filter((m) =>
    cles.some((cle) => m.cleP === cle || (cle.length >= 8 && m.cleP.includes(cle)))
    && m.debut <= date && (!m.fin || m.fin >= date));
  candidats.sort((a, b) => (b.debut ?? "").localeCompare(a.debut ?? ""));
  return candidats[0]?.id ?? null;
}

const gouvernementDu = (extrait) =>
  /gouvernement\s+([A-ZÉÈ][a-zéè]+(?:\s+[IV]+)?)/.exec(extrait)?.[1] ?? "";

// ---------------------------------------------------------------------------
// Mode corpus (import en masse d'un jour) : écrit UNIQUEMENT cabinets_ministeriels.
// Les mesures ministres ne sont pas écrites (la table `ministres` est déjà
// tenue par ailleurs) : elles servent à tenir le cache des mandats (ctx) pour
// rattacher chaque cabinet au bon mandat — cache d'abord, puis une recherche
// dans la table existante en cas de miss. Écritures groupées, cessations par
// PATCH filtré. Les rapprochements collab_id / personne_id se font ensuite en
// une passe SQL (scripts/rapprochements.sql).
// ---------------------------------------------------------------------------
export async function importerMesuresBrut(date, mesures, ctx, notifier = false) {
  const now = new Date().toISOString();
  const out = { date, nb: mesures.length, ministres: 0, cabinets: 0, erreurs: [] };
  const aEcrire = [];
  const dejaEcrits = new Map(); // id cabinet → ligne déjà au lot (dédoublonnage)
  // Pages du site impactées par ce jour : soumises à IndexNow en fin d'import
  // (notifier=true en mode quotidien uniquement — jamais en rattrapage corpus).
  const pages = new Set(["/gouv", "/gouv/explorer", "/daily", `/daily/${date}`]);
  for (const m of mesures) {
    try {
      if (m.role === "ministre") {
        const cle = cleNom(m.prenom, m.nom);
        if (m.type === "cessation") ctx.ministres.delete(cle);
        else ctx.ministres.set(cle, idMinistre(m.nom, m.date));
        out.ministres++;
      } else {
        const ref = m.ministre ?? { prenom: "", nom: "" };
        if (!ctx.mandats) await chargerMandats(ctx).catch(() => { ctx.mandats = []; });
        let ministreId = null;
        if (ref.nom) {
          const cleRef = cleNom(ref.prenom, ref.nom);
          ministreId = ctx.ministres.get(cleRef) ?? null;
          if (!ministreId) {
            ministreId = await chercherMinistre(ref.prenom, ref.nom).catch(() => null);
            if (ministreId) ctx.ministres.set(cleRef, ministreId);
          }
        }
        // Fallback portefeuille : « directeur de cabinet du ministre de
        // l'intérieur » → mandat en fonction à cette date pour ce portefeuille.
        if (!ministreId && m.portefeuille) {
          ministreId = mandaterParPortefeuille(ctx, m.portefeuille, m.date);
        }
        if (!ministreId) { out.erreurs.push(`${m.prenom} ${m.nom} : rattachement introuvable${m.portefeuille ? ` (${m.portefeuille})` : ""}`); continue; }
        const cle = cleNom(m.prenom, m.nom);
        if (m.type === "cessation") {
          await maj("cabinets_ministeriels", { fin: m.date, synced_at: now },
            new URLSearchParams({ collab_cle: `eq.${cle}`, fin: "is.null" }));
          // La fiche du collaborateur (s'il existe dans le référentiel) change aussi.
          if (notifier) {
            const c = await chercherCollaborateur(m.prenom, m.nom).catch(() => null);
            if (c?.slug) pages.add(`/collab/${c.slug}`);
          }
        } else {
          const id = idCabinet(ministreId, m.prenom, m.nom);
          const existant = aEcrire.find((x) => x.id === id) ?? dejaEcrits.get(id);
          if (!existant) {
          aEcrire.push({
            id, ministre_id: ministreId,
            personne_id: null, collab_id: null, collab_cle: cle,
            collab_nom: m.nom.toUpperCase(), collab_prenom: m.prenom,
            fonction: m.fonction || "membre de cabinet",
            source: `JORF ${m.id_texte}`, confiance: "officiel", date_source: m.date,
            debut: m.date, fin: null,
          });
          } else {
            // même cabinet déjà écrit dans ce lot ou ce jour : on complète juste fin si cessation ultérieure
            dejaEcrits.set(id, existant);
          }
          if (notifier) pages.add(`/gouv/m/${ministreId}`); // fiche du ministre (son cabinet a bougé)
        }
        out.cabinets++;
      }
    } catch (e) { out.erreurs.push(`${m.prenom} ${m.nom} : ${e.message}`); }
  }
  if (aEcrire.length) {
    // Rapprochement immédiat avec la table collaborateurs (collab_id) par
    // cle : une seule requête pour tout le lot. Les lignes sans équivalent
    // restent à null (pas collaborateur parlementaire) ; la passe SQL
    // (scripts/rapprochements.sql) demeure utile pour personne_id.
    const cles = [...new Set(aEcrire.map((l) => l.collab_cle))].filter(Boolean);
    if (cles.length) {
      const connus = await lire("collaborateurs", new URLSearchParams({
        select: "collab_id,collab_prenom,collab_nom,collab_cle,slug",
        collab_cle: `in.(${cles.map((c) => `"${c}"`).join(",")})`, limit: "1000",
      })).catch(() => []);
      const parCle = new Map(connus.map((c) => [c.collab_cle, c]));
      for (const l of aEcrire) {
        const c = parCle.get(l.collab_cle);
        if (c) { l.collab_id = c.collab_id; l.collab_prenom = c.collab_prenom; l.collab_nom = c.collab_nom.toUpperCase();
          if (notifier && c.slug) pages.add(`/collab/${c.slug}`); // nouveau poste visible sur son parcours
        }
      }
    }
    await ecrire("cabinets_ministeriels", aEcrire);
    for (const l of aEcrire) dejaEcrits.set(l.id, l);
  }
  await ecrire("jorf_releves", [{
    date_jorf: date, nb_mesures: out.nb, nb_ministres: out.ministres, nb_cabinets: out.cabinets,
    erreurs: out.erreurs.slice(0, 5).join(" | ").slice(0, 500), synced_at: now,
  }]);
  out.pages = [...pages];
  if (notifier) await notifierIndexNow(out.pages);
  return out;
}

// Un jour du JORF : relève puis import via la même logique que le corpus
// (importerMesuresBrut). Le mode quotidien partage désormais la politique
// d'écriture du corpus : seule la table cabinets_ministeriels est écrite —
// la table ministres est tenue par ailleurs (CSV gouvernement) et les
// rapprochements collab_id se font inline. Les mesures « ministre » servent
// uniquement de cache de rattachement (aucune écriture).
const ctxJour = { ministres: new Map() };
export async function importerJour(date) {
  const mesures = await releverJour(date);
  return importerMesuresBrut(date, mesures, ctxJour, true);
}

export const demain = (date) => new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);

export async function joursBalayes() {
  // jorf_releves n'est pas en lecture publique : clé service_role obligatoire.
  const rows = await lirePrive("jorf_releves", new URLSearchParams({ select: "date_jorf", limit: "10000" }));
  return new Set(rows.map((x) => x.date_jorf));
}

// Balayage d'une plage de jours, en reprenant là où il s'était arrêté.
// \`forcer\` ignore les jours déjà « balayés » (utile après un bug : des jours
// marqués avec 0 mesure alors que le JORF en publiait). Si tout échoue d'emblée
// (réseau coupé, table absente…), on s'arrête vite avec un message clair
// au lieu d'attraper des centaines d'erreurs.
export async function balayer(debut, fin, verbeux = true, forcer = false) {
  const vus = forcer ? new Set() : await joursBalayes().catch(() => new Set());
  const jours = [];
  let d = debut, restants = 0, echecsConsecutifs = 0, enErreur = 0;
  while (d <= fin) {
    if (vus.has(d)) { d = demain(d); continue; }
    const jour = await importerJour(d).catch((e) => ({ date: d, nb: 0, ministres: 0, cabinets: 0, erreurs: [e.message] }));
    jours.push(jour);
    if (verbeux) {
      const errs = jour.erreurs.length ? ` — ${jour.erreurs[0]}` : "";
      console.log(`${jour.date} : ${jour.nb} mesure(s) — ${jour.ministres} ministre(s), ${jour.cabinets} cabinet(s)${errs}`);
    }
    // Un jour n'est « balayé » que si son relevé a pu être écrit ; sinon il
    // reste à faire et sera repris au prochain passage.
    const echec = jour.erreurs.length > 0;
    enErreur += echec ? 1 : 0;
    echecsConsecutifs = echec ? echecsConsecutifs + 1 : 0;
    if (!echec) vus.add(d);
    d = demain(d);
    restants++;
    if (echecsConsecutifs >= 8 && enErreur === restants) {
      throw new Error(`Balayage interrompu : les ${restants} premiers jours échouent tous (${jour.erreurs[0] ?? "cause inconnue"}). Vérifier l'accès à la DILA et les tables Supabase (node bin/jorf-bot.js diagnostique).`);
    }
  }
  return { jours, restants, enErreur };
}

// Statut : jours balayés, prochaine étape.
export async function statut() {
  const rows = await lirePrive("jorf_releves", new URLSearchParams({ select: "date_jorf", order: "date_jorf", limit: "5000" }))
    .catch(() => []);
  const vus = new Set(rows.map((x) => x.date_jorf));
  const hier = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let d = "2017-01-01", prochain = null, restants = 0;
  while (d <= hier) { if (!vus.has(d)) { if (!prochain) prochain = d; restants++; } d = demain(d); }
  return { scan: { jours: vus.size, premiere: rows[0]?.date_jorf ?? null, derniere: rows[rows.length - 1]?.date_jorf ?? null }, prochain, restants };
}
