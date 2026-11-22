// Balayage du Journal officiel (JORF, edition « Lois et decrets ») :
// téléchargement des dumps quotidiens de la DILA (JORFSIMPLE), extraction des
// mesures nominatives qui concernent le gouvernement (ministres) et les
// cabinets ministériels (directeurs, chefs de cabinet, conseillers…), et
// des rubriques « Informations parlementaires » (composition de l'Assemblée
// et du Sénat : décès, remplacements, élections, démissions, nominations au
// Gouvernement — journal brut pour la réconciliation côté collaborateurs).
// Portage 1:1 de webapp/lib/jorf.ts — zéro dépendance, Node natif.
// Source : dumps JORFSIMPLE de la DILA (Premier ministre / data.gouv.fr,
// réutilisation libre).

import { gunzipSync, inflateRawSync } from "node:zlib";

const BASE = "https://echanges.dila.gouv.fr/OPENDATA/JORFSIMPLE";

export const lienJORF = (date) => `${BASE}/JORFSIMPLE_${date.replace(/-/g, "")}.zip`;

export const cleNom = (...parts) => {
  const txt = parts.join(" ").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[-'’`.]/g, " ").replace(/[^a-z0-9 ]/g, "");
  return txt.split(/\s+/).filter(Boolean).sort().join(" ");
};

// ---------------------------------------------------------------------------
// 1. Zip : lecture du répertoire central puis décompression (méthode 0 ou 8).
// ---------------------------------------------------------------------------
export function xmlDuZip(buf) {
  const fin = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // EOCD
  if (fin < 0) throw new Error("JORF : zip illisible (pas de fin de répertoire)");
  const nbEntrees = buf.readUInt16LE(fin + 10);
  const dir = buf.readUInt32LE(fin + 16);
  const out = [];
  let p = dir;
  for (let i = 0; i < nbEntrees; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const methode = buf.readUInt16LE(p + 10);
    const tailleCompressee = buf.readUInt32LE(p + 20);
    const taille = buf.readUInt32LE(p + 24);
    const nomLong = buf.readUInt16LE(p + 28);
    const extraLong = buf.readUInt16LE(p + 30);
    const commLong = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const nom = buf.toString("utf8", p + 46, p + 46 + nomLong);
    if (nom.toLowerCase().endsWith(".xml") && taille > 0 && taille < 60_000_000) {
      const nl = buf.readUInt16LE(offset + 26);
      const el = buf.readUInt16LE(offset + 28);
      const debut = offset + 30 + nl + el;
      const brut = buf.subarray(debut, debut + tailleCompressee);
      out.push(methode === 8 ? inflateRawSync(brut).toString("utf8") : brut.toString("utf8"));
    }
    p += 46 + nomLong + extraLong + commLong;
  }
  if (!out.length) throw new Error("JORF : aucun fichier XML dans le zip");
  return out;
}

// ---------------------------------------------------------------------------
// 2. XML : analyse légère (balises plates du DTD LEGIFRANCE).
// ---------------------------------------------------------------------------
const balise = (xml, champ, dans) => {
  const base = dans ?? xml;
  const m = new RegExp(`<${champ}[^>]*>([\\s\\S]*?)</${champ}>`, "i").exec(base);
  return m ? m[1].trim() : null;
};

export const sansBalises = (x) =>
  x.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ").trim();

function personnesDuTexte(metaSm) {
  const out = [];
  for (const m of metaSm.matchAll(/<PERSONNE\b([^>]*?)\/>|<PERSONNE\b([^>]*)>([\s\S]*?)<\/PERSONNE>/gi)) {
    const attrs = (m[1] ?? m[2] ?? "") + " " + (m[3] ?? "");
    const nom = /nom\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? sansBalises(balise(m[0], "NOM") ?? "");
    const prenom = /prenom\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? sansBalises(balise(m[0], "PRENOM") ?? "");
    const civ = /civilite\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? sansBalises(balise(m[0], "CIVILITE") ?? "");
    if (nom && prenom) out.push({ civilite: /^\s*Mme|Madame/i.test(civ) ? "Mme" : "M.", prenom: prenom.trim(), nom: nom.trim() });
  }
  return out;
}

const FONCTIONS_CABINET = [
  "directeur adjoint de cabinet", "directrice adjointe de cabinet",
  "adjoint au directeur de cabinet", "adjointe au directeur de cabinet",
  "directeur de cabinet", "directrice de cabinet",
  "chef de cabinet", "cheffe de cabinet",
  "conseiller", "conseillère",
  "conseiller technique", "conseillère technique",
  "chef adjoint de cabinet", "cheffe adjointe de cabinet",
  "chargé de mission", "chargée de mission",
];

const nomApostrophe = (prenom, nom) => {
  const echappe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s]+/g, "\\s+");
  return new RegExp(`${echappe(nom)}\\s*[,«]?\\s*${echappe(prenom)}|${echappe(prenom)}\\s+${echappe(nom)}`, "i");
};

export function analyserJORF(xml, dateDefaut) {
  const out = [];
  const blocs = xml.match(/<TEXTE\b[\s\S]*?<\/TEXTE>/gi) ?? [xml];
  for (const bloc of blocs) {
    const titre = sansBalises(balise(bloc, "TITRE") ?? "");
    if (!/(nomination|cessation de fonctions|fin de fonctions|révocation|relatif à la composition|portant cessation)/i.test(titre)) continue;
    const nature = balise(bloc, "NATURE") ?? "Décret";
    if (!/^(décret|arrêté)$/i.test(nature)) continue;
    const dateBrute = balise(bloc, "DATE_TEXTE") ?? (dateDefaut ? dateDefaut.replace(/-/g, "") : "");
    const date = dateBrute ? `${dateBrute.slice(0, 4)}-${dateBrute.slice(4, 6)}-${dateBrute.slice(6, 8)}` : dateDefaut ?? "";
    const id = balise(bloc, "ID_TEXTE") ?? `${date}-${out.length}`;
    const sm = balise(bloc, "SM") ?? "";
    const contenu = sansBalises(balise(bloc, "CONTENU") ?? "");
    const texte = `${titre}. ${contenu}`;
    const type = /(cessation de fonctions|fin de fonctions|révocation|cessation)/i.test(titre) ? "cessation" : "nomination";
    const personnes = personnesDuTexte(sm);
    for (const p of personnes) {
      const autour = (() => {
        const m = nomApostrophe(p.prenom, p.nom).exec(texte);
        if (!m) return texte.slice(0, 400);
        return texte.slice(Math.max(0, m.index - 260), Math.min(texte.length, m.index + 420));
      })();
      const rMinistre = /(ministre d[e']\s?[ÉEa-zéèêàâ\s,'-]{3,80}|ministre chargé[e]? de[^,.;]{3,80}|Premier ministre|secrétaire d[ée]?tat [àa][^,.;]{3,60})/i.exec(autour);
      const rCabinet = FONCTIONS_CABINET.map((f) => new RegExp(f, "i").exec(autour)).find(Boolean);
      const role = rCabinet && !/ministre\s/i.test(autour.slice(0, 40)) ? "cabinet" : rMinistre ? "ministre" : rCabinet ? "cabinet" : "ministre";
      const ministre = (() => {
        if (role !== "cabinet") return null;
        const m = /(?:auprès|chez|cabinet)\s+d[e']?\s*(?:M\.|Mme|Madame|Monsieur)\s+([A-ZÉÈ][\p{L}'’-]+)\s+([A-ZÉÈ][\p{L}'’-]+(?:\s+[A-ZÉÈ][\p{L}'’-]+)?)/u.exec(autour);
        if (m) {
          const nom = m[1] === m[1].toUpperCase() ? m[1] : m[2];
          const prenom = m[1] === m[1].toUpperCase() ? m[2] : m[1];
          return { prenom, nom };
        }
        return null;
      })();
      out.push({
        id_texte: id, date, nature, titre, type, role,
        civilite: p.civilite, prenom: p.prenom, nom: p.nom,
        fonction: (rCabinet?.[0] ?? rMinistre?.[0] ?? "").trim(),
        portefeuille: role === "ministre" ? (rMinistre?.[0] ?? "").replace(/^ministre\s*/i, "").trim() : "",
        ministre,
        extrait: autour.replace(/\s+/g, " ").slice(0, 400),
      });
    }
    if (!personnes.length) {
      for (const m of texte.matchAll(/(?:M\.|Mme)\s+([A-ZÉÈ][\p{L}'’-]+)\s+([A-ZÉÈ][\p{L}'’-]+(?:\s+[A-ZÉÈ][\p{L}'’-]+){0,2})/gu)) {
        const autour = texte.slice(Math.max(0, m.index - 100), m.index + 320);
        if (!/(cabinet|ministre|secrétaire d[ée]?tat)/i.test(autour)) continue;
        out.push({
          id_texte: id, date, nature, titre,
          type: /(cessation|révocation|fin de fonctions)/i.test(titre) ? "cessation" : "nomination",
          role: /cabinet|conseiller/i.test(autour) && !/ministre\s/i.test(autour.slice(0, 40)) ? "cabinet" : "ministre",
          civilite: m[0].startsWith("Mme") ? "Mme" : "M.",
          prenom: m[1], nom: m[2],
          fonction: FONCTIONS_CABINET.map((f) => new RegExp(f, "i").exec(autour)).find(Boolean)?.[0] ?? (/ministre/i.test(autour) ? "ministre" : ""),
          portefeuille: (/(ministre d[e']?\s?[a-zéèêàâ\s,'-]{3,80})/i.exec(autour)?.[0] ?? "").replace(/^ministre\s*/i, "").trim(),
          ministre: null,
          extrait: autour,
        });
      }
    }
  }
  const vus = new Set();
  return out.filter((m) => {
    const k = `${m.id_texte}|${cleNom(m.prenom, m.nom)}|${m.type}|${m.role}`;
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
}

const UA = "DataParl (https://www.dataparl.fr), jorf-bot";

// Fenêtre disponible sur JORFSIMPLE (index du dossier) : la DILA ne conserve
// qu'une fenêtre glissante de quelques mois de dumps quotidiens. Savoir jusqu'où
// on peut remonter évite de « balayer » des jours qui n'existent plus.
// ⚠ Depuis le 13/07/2025 la DILA publie des JORFSIMPLE_<date>-<heure>.tar.gz
// (et non plus des .zip) : l'index liste les deux extensions.
export async function fenetreJorfsimple() {
  const r = await fetch(`${BASE}/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`index JORFSIMPLE : HTTP ${r.status}`);
  const texte = await r.text();
  const dates = [...texte.matchAll(/JORFSIMPLE_(\d{8})-\d+\.t(?:ar\.gz|gz)/gi)]
    .map((m) => m[1]);
  const datesZip = [...texte.matchAll(/JORFSIMPLE_(\d{8})\.zip/gi)].map((m) => m[1]);
  const toutes = [...new Set([...datesZip, ...dates])].sort();
  if (!toutes.length) throw new Error("index JORFSIMPLE illisible (aucun dump listé)");
  return { premier: toutes[0], dernier: toutes[toutes.length - 1], nb: toutes.length };
}

// Index JORFSIMPLE mis en cache : le balayage d'une plage de jours interroge
// l'index une seule fois au lieu d'une requête par jour.
let cacheIndex = { at: 0, fichiers: [] };
export async function indexJorfsimple() {
  if (cacheIndex.fichiers.length && Date.now() - cacheIndex.at < 30 * 60_000) return cacheIndex.fichiers;
  const r = await fetch(`${BASE}/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`index JORFSIMPLE : HTTP ${r.status}`);
  // l'index Apache liste chaque nom deux fois (lien + texte) : dédoublonnage
  const fichiers = [...new Set([...(await r.text()).matchAll(/JORFSIMPLE_(\d{8})-?([\w.]*)\.t(?:ar\.gz|gz)/gi)]
    .map((m) => `JORFSIMPLE_${m[1]}-${m[2] || "000000"}.tar.gz`))]
    .sort(); // trié : le dernier dump d'une journée = édition complète du soir
  if (!fichiers.length) throw new Error("index JORFSIMPLE illisible (aucun tar.gz listé)");
  cacheIndex = { at: Date.now(), fichiers };
  return fichiers;
}

// Dernier dump .tar.gz publié pour un jour donné (édition du soir). Un jour
// sans publication (dimanche) n'apparaît pas dans l'index → [].
export async function fichiersJour(date) {
  const pref = date.replace(/-/g, "");
  return (await indexJorfsimple()).filter((f) => f.startsWith(`JORFSIMPLE_${pref}-`));
}

// ---------------------------------------------------------------------------
// 2bis. tar.gz : décompression (zlib) puis lecture minimaliste du format tar
// POSIX (blocs de 512 octets, entête ustar/GNU ; gère l'extension longname
// « L »). Rend le contenu UTF-8 de chaque membre .xml.
// ---------------------------------------------------------------------------
export function xmlDuTarGz(buf) {
  const decompresse = gunzipSync(buf);
  const out = [];
  let p = 0, nomEnAttente = null;
  while (p + 512 <= decompresse.length) {
    if (decompresse[p] === 0 && decompresse[p + 1] === 0) break; // blocs nuls finaux
    const nom = decompresse.toString("utf8", p, p + 100).split("\0")[0];
    const taille = parseInt(decompresse.toString("ascii", p + 124, p + 136).replace(/[\0 ]/g, ""), 8) || 0;
    const type = String.fromCharCode(decompresse[p + 156] || 0x30);
    const debut = p + 512;
    if (type === "L") {
      nomEnAttente = decompresse.toString("utf8", debut, debut + taille).split("\0")[0];
    } else if (type === "0" || type === "\0" || type === "7") {
      const nomFinal = nomEnAttente ?? nom;
      nomEnAttente = null;
      if (/\.xml$/i.test(nomFinal) && taille > 0 && taille < 10_000_000) {
        out.push(decompresse.subarray(debut, debut + taille).toString("utf8"));
      }
    } else {
      nomEnAttente = null; // répertoires, pax 'x'… : ignorés
    }
    p = debut + Math.ceil(taille / 512) * 512;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2ter. XML « JORFTEXT » des dumps quotidiens tar.gz (format DILA depuis le
// 13/07/2025) : plus de balises <PERSONNE>, TITRE court + TITREFULL porteur
// du sens, NATURE en MAJUSCULES non accentuées, noms en clair dans les
// BLOC_TEXTUEL des articles. Seuls les textes PUBLIÉS ce jour-là sont retenus
// (le dump du soir embarque aussi d'anciens textes rectifiés).
// ---------------------------------------------------------------------------
export function analyserTexteSimple(xml, dateJour) {
  const out = [];
  const natureBrute = balise(xml, "NATURE") ?? "";
  const nature = { DECRET: "Décret", ARRETE: "Arrêté" }[natureBrute.trim().toUpperCase()] ?? natureBrute.trim();
  if (!/^(décret|arrêté)$/i.test(nature)) return out;
  const titre = sansBalises(balise(xml, "TITREFULL") ?? balise(xml, "TITRE") ?? "");
  if (!/(nomination|cessation de fonctions|fin de fonctions|révocation|relatif à la composition|portant cessation)/i.test(titre)) return out;
  const datePubli = balise(xml, "DATE_PUBLI")?.trim() ?? "";
  // Le dump du soir embarque l'édition du jour et les textes récemment
  // rectifiés (parfois très anciens). On retient les textes publiés depuis
  // deux jours (jours fériés/dimanche décalent l'édition) : les écritures
  // sont idempotentes (upsert), les recouvrements ne doublonnent rien.
  const laVeille = (iso, n) => new Date(Date.parse(iso) - n * 86_400_000).toISOString().slice(0, 10);
  if (dateJour && datePubli && (datePubli < laVeille(dateJour, 2) || datePubli > dateJour)) return out;
  const date = dateJour || datePubli;
  if (!date) return out;
  const id = balise(xml, "ID") ?? `${date}-0`;
  const corps = [...xml.matchAll(/<BLOC_TEXTUEL\b[^>]*>([\s\S]*?)<\/BLOC_TEXTUEL>/gi)]
    .map((m) => sansBalises(m[1])).join(" ");
  const texte = `${titre}. ${corps}`;
  const type = /(cessation de fonctions|fin de fonctions|révocation|cessation)/i.test(titre) ? "cessation" : "nomination";
  for (const m of texte.matchAll(/(?:M\.|Mme)\s+([A-ZÉÈ][\p{L}'’-]+)\s+([A-ZÉÈ][\p{L}'’-]+(?:\s+[A-ZÉÈ][\p{L}'’-]+){0,2})/gu)) {
    const apres = texte.slice(m.index, m.index + 400); // depuis le nom : « est nommé conseiller… au cabinet du ministre de l'intérieur »
    const avant = texte.slice(Math.max(0, m.index - 120), m.index);
    const rCabinet = FONCTIONS_CABINET.map((f) => new RegExp(f, "i").exec(apres)).find(Boolean);
    const rMinistre = /(ministre d[e']\s?[ÉEa-zéèêàâ\s,'-]{3,80}|ministre chargé[e]? de[^,.;]{3,80}|Premier ministre|secrétaire d[ée]?tat [àa][^,.;]{3,60})/i.exec(apres);
    // Un membre de cabinet se reconnaît à une fonction de cabinet APRÈS son
    // nom et au mot « cabinet » dans le contexte (le titre des arrêtés dit
    // toujours « portant nomination au cabinet du/de la … ») ; sinon c'est une
    // autre nomination nominative (Conseil d'État, administration…) : pas un
    // membre de cabinet.
    const role = rCabinet && /cabinet/i.test(`${titre} ${avant} ${apres}`) ? "cabinet" : "ministre";
    const autour = `${avant} ${apres}`;
    const ministre = (() => {
      if (role !== "cabinet") return null;
      const r = /(?:auprès|chez|cabinet)\s+d[e']?\s*(?:M\.|Mme|Madame|Monsieur)\s+([A-ZÉÈ][\p{L}'’-]+)\s+([A-ZÉÈ][\p{L}'’-]+(?:\s+[A-ZÉÈ][\p{L}'’-]+)?)/u.exec(autour);
      if (r) {
        const nom = r[1] === r[1].toUpperCase() ? r[1] : r[2];
        const prenom = r[1] === r[1].toUpperCase() ? r[2] : r[1];
        return { prenom, nom };
      }
      return null;
    })();
    out.push({
      id_texte: id, date, nature, titre, type, role,
      civilite: m[0].startsWith("Mme") ? "Mme" : "M.",
      prenom: m[1], nom: m[2],
      fonction: (rCabinet?.[0] ?? (role === "ministre" ? rMinistre?.[0] : "") ?? "").trim(),
      portefeuille: role === "cabinet"
        ? // Le portefeuille figure dans le titre de l'arrêté (« portant
          // nomination au cabinet du ministre de l'économie… ») : plus fiable
          // que le voisinage du nom, surtout quand le cabinet a dix membres.
          (((/cabinet\s+d(?:u|e la|e l'|es)\s+([^,.;]{3,90})/i.exec(titre)?.[1]
            ?? (rMinistre ?? /ministre\s+[^,.;]{3,80}/i.exec(autour))?.[0] ?? "")
            .replace(/^ministre\s*/i, "")
            .split(/\s(?:à compter|prenant effet|à partir|jusqu'|pour la durée|en remplacement)/i)[0].trim()))
        : (rMinistre?.[0] ?? "").replace(/^ministre\s*/i, "").trim(),
      ministre,
      extrait: autour.replace(/\s+/g, " ").slice(0, 400),
    });
  }
  const vus = new Set();
  return out.filter((m) => {
    const k = `${m.id_texte}|${cleNom(m.prenom, m.nom)}|${m.type}|${m.role}`;
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 2quater : rubriques « Informations parlementaires » (nature DILA
// INFORMATIONS_PARLEMENTAIRES ; INFORMATIONS_DIVERSES admise pour
// l'historique) : composition de l'Assemblée nationale / du Sénat — décès et
// remplacement d'un parlementaire, élections, démissions, nominations au
// Gouvernement, groupes politiques… Le contenu est en prose dans
// BLOC_TEXTUEL : le bot journalise le texte intégral + une classification
// grossière (evenement). L'interprétation fine (qui remplace qui, quelle
// date mandater) se fait côté collaborateurs (collabs/parlementaires_reco.py
// → suppleances.csv) : le bot ne tranche jamais seul.
// ---------------------------------------------------------------------------
const CHAMBRES_INFO = [
  ["assemblee", /assemblée nationale/i],
  ["senat", /sénat/i],
  ["parlement_europeen", /parlement européen/i],
];
const EVENEMENTS_INFO = [
  ["deces_remplacement", /décès et remplacement|tristesse de faire part du décès[\s\S]{0,400}remplacé/i],
  ["deces", /\bdécès\b|est décédé/i],
  ["demission", /démission/i],
  ["nomination_gouvernement", /nommé(?:e)? (?:au gouvernement|au Gouvernement|membre du Gouvernement|ministre)/i],
  ["election", /élection|est élu|élue le|législative partielle|partielle/i],
  ["composition", /composition de l'| composition du/i],
  ["nominations", /nominations? et avis/i],
];

export function analyserInfosParlementaires(xml, dateJour) {
  const out = [];
  const nature = (balise(xml, "NATURE") ?? "").trim();
  if (!/^informations?_(parlementaires|diverses)$/i.test(nature)) return out;
  const datePubli = balise(xml, "DATE_PUBLI")?.trim() ?? "";
  // Même garde que analyserTexteSimple : le dump du soir embarque aussi des
  // textes rectifiés parfois anciens — on retient les textes publiés depuis
  // deux jours (jours fériés/dimanche décalent l'édition), écriture
  // idempotente sur l'id du texte.
  const laVeille = (iso, n) => new Date(Date.parse(iso) - n * 86_400_000).toISOString().slice(0, 10);
  if (dateJour && datePubli && (datePubli < laVeille(dateJour, 2) || datePubli > dateJour)) return out;
  const date = dateJour || datePubli;
  if (!date) return out;
  const id = balise(xml, "ID");
  if (!id) return out;
  const contenu = [...xml.matchAll(/<BLOC_TEXTUEL\b[^>]*>([\s\S]*?)<\/BLOC_TEXTUEL>/gi)]
    .map((m) => sansBalises(m[1])).join(" ").replace(/\s+/g, " ").trim();
  if (!contenu) return out;
  const chambre = CHAMBRES_INFO.find(([, re]) => re.test(contenu))?.[0] ?? "";
  const evenement = EVENEMENTS_INFO.find(([, re]) => re.test(contenu))?.[0] ?? "autre";
  out.push({
    id, date_jorf: date, nature: nature.toUpperCase(),
    titre: sansBalises(balise(xml, "TITRE") ?? ""),
    objet: sansBalises(balise(xml, "TITREFULL") ?? ""),
    chambre, evenement,
    contenu: contenu.slice(0, 4000),
    confiance: "officiel",
  });
  return out;
}

// Téléchargement d'un dump JORFSIMPLE, trois essais avec pauses croissantes
// (la DILA coupe parfois les connexions). Rend null si absent (404 : retiré
// de la fenêtre glissante entre-temps), une erreur sinon.
async function telechargerDump(url, date) {
  let r = null;
  let derniereErreur = null;
  for (let essai = 0; essai < 3; essai += 1) {
    try {
      r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
      break;
    } catch (e) {
      derniereErreur = e;
      r = null;
      await new Promise((ok) => setTimeout(ok, 2000 * (essai + 1)));
    }
  }
  if (!r) throw new Error(`JORF ${date} : dump inaccessible (${derniereErreur?.message ?? "réseau"})`);
  if (r.status === 404) return null; // retiré de la fenêtre glissante entre-temps
  if (!r.ok) throw new Error(`JORF ${date} : HTTP ${r.status} (${url})`);
  const brut = Buffer.from(await r.arrayBuffer());
  if (brut.length > 80_000_000) throw new Error(`JORF ${date} : tar.gz trop volumineux (${url})`);
  return brut;
}

// Un jour du JORF, complet : mesures nominatives + rubriques
// « Informations parlementaires ». ⚀ TOUTES les éditions du jour sont
// balayées, pas seulement celle du soir : vérifié sur le terrain
// (2026-11-21), le dump du soir N'EMBARQUE PAS les
// INFORMATIONS_PARLEMENTAIRES de l'édition du matin — « Composition de
// l'Assemblée » (décès/remplacement du 21/11/2026) n'était que dans le dump
// 01h09. Les écritures étant idempotentes (upsert sur id), recouvrir matin +
// soir ne crée aucun doublon ; un texte rectifié dans la soirée écrase juste
// la version du matin. Rend { mesures, infos }.
export async function releverJourComplet(date) {
  const fichiers = await fichiersJour(date);
  if (!fichiers.length) return { mesures: [], infos: [] }; // pas de publication ce jour-là (ou hors fenêtre)
  const mesures = [];
  const infos = [];
  const vusM = new Set();
  const vusI = new Set();
  for (const nom of fichiers) {
    const brut = await telechargerDump(`${BASE}/${nom}`, date);
    if (!brut) continue;
    for (const x of xmlDuTarGz(brut)) {
      for (const m of analyserTexteSimple(x, date)) {
        const k = `${m.id_texte}|${cleNom(m.prenom, m.nom)}|${m.type}|${m.role}`;
        if (!vusM.has(k)) { vusM.add(k); mesures.push(m); }
      }
      for (const i of analyserInfosParlementaires(x, date)) {
        if (!vusI.has(i.id)) { vusI.add(i.id); infos.push(i); }
      }
    }
  }
  return { mesures, infos };
}

// Compat : les mesures nominatives seules (diagnostique CLI, tests).
export async function releverJour(date) {
  return (await releverJourComplet(date)).mesures;
}

// ---------------------------------------------------------------------------
// 3. XML du dump Freemium global (famille article/) : format spécifique.
//    Le texte parent vit dans CONTEXTE/TEXTE (attributs cid, date_publi,
//    nature + TITRE_TXT), le contenu de l'article dans BLOC_TEXTUEL.
//    Produit exactement les mêmes mesures qu'analyserJORF.
// ---------------------------------------------------------------------------
export function analyserArticleFreemium(xml) {
  const out = [];
  const ctx = /<CONTEXTE>[\s\S]*?<TEXTE\b([^>]*)>([\s\S]*?)<\/TEXTE>/i.exec(xml);
  if (!ctx) return out;
  const attrs = ctx[1];
  const cid = / cid="([^"]+)"/i.exec(attrs)?.[1] ?? "";
  const date = / date_publi="([^"]+)"/i.exec(attrs)?.[1] ?? "";
  const natureBrute = / nature="([^"]+)"/i.exec(attrs)?.[1] ?? "";
  const nature = { DECRET: "Décret", ARRETE: "Arrêté" }[natureBrute.toUpperCase()] ?? natureBrute;
  const titre = sansBalises(/<TITRE_TXT\b[^>]*>([\s\S]*?)<\/TITRE_TXT>/i.exec(ctx[2])?.[1] ?? "");
  if (!/(nomination|cessation de fonctions|fin de fonctions|révocation|relatif à la composition|portant cessation)/i.test(titre)) return out;
  if (!/^(décret|arrêté)$/i.test(nature)) return out;
  if (!date) return out;
  const id = cid || `${date}-0`;
  const sm = /<SM\b[^>]*>([\s\S]*?)<\/SM>/i.exec(xml)?.[1] ?? "";
  const bloc = /<BLOC_TEXTUEL\b[^>]*>([\s\S]*?)<\/BLOC_TEXTUEL>/i.exec(xml);
  const contenu = sansBalises(bloc?.[1] ?? "");
  const texte = `${titre}. ${contenu}`;
  const type = /(cessation de fonctions|fin de fonctions|révocation|cessation)/i.test(titre) ? "cessation" : "nomination";
  const personnes = personnesDuTexte(sm);
  for (const p of personnes) {
    const autour = (() => {
      const m = nomApostrophe(p.prenom, p.nom).exec(texte);
      if (!m) return texte.slice(0, 400);
      return texte.slice(Math.max(0, m.index - 260), Math.min(texte.length, m.index + 420));
    })();
    const rMinistre = /(ministre d[e']\s?[ÉEa-zéèêàâ\s,'-]{3,80}|ministre chargé[e]? de[^,.;]{3,80}|Premier ministre|secrétaire d[ée]?tat [àa][^,.;]{3,60})/i.exec(autour);
    const rCabinet = FONCTIONS_CABINET.map((f) => new RegExp(f, "i").exec(autour)).find(Boolean);
    const role = rCabinet && !/ministre\s/i.test(autour.slice(0, 40)) ? "cabinet" : rMinistre ? "ministre" : rCabinet ? "cabinet" : "ministre";
    const ministre = (() => {
      if (role !== "cabinet") return null;
      const m = /(?:auprès|chez|cabinet)\s+d[e']?\s*(?:M\.|Mme|Madame|Monsieur)\s+([A-ZÉÈ][\p{L}'’-]+)\s+([A-ZÉÈ][\p{L}'’-]+(?:\s+[A-ZÉÈ][\p{L}'’-]+)?)/u.exec(autour);
      if (m) {
        const nom = m[1] === m[1].toUpperCase() ? m[1] : m[2];
        const prenom = m[1] === m[1].toUpperCase() ? m[2] : m[1];
        return { prenom, nom };
      }
      return null;
    })();
    out.push({
      id_texte: id, date, nature, titre, type, role,
      civilite: p.civilite, prenom: p.prenom, nom: p.nom,
      fonction: (rCabinet?.[0] ?? rMinistre?.[0] ?? "").trim(),
      portefeuille: (rMinistre?.[0] ?? "").replace(/^ministre\s*/i, "").trim(),
      ministre,
      extrait: autour.replace(/\s+/g, " ").slice(0, 400),
    });
  }
  if (!personnes.length) {
    for (const m of texte.matchAll(/(?:M\.|Mme)\s+([A-ZÉÈ][\p{L}'’-]+)\s+([A-ZÉÈ][\p{L}'’-]+(?:\s+[A-ZÉÈ][\p{L}'’-]+){0,2})/gu)) {
      const autour = texte.slice(Math.max(0, m.index - 100), m.index + 320);
      if (!/(cabinet|ministre|secrétaire d[ée]?tat)/i.test(autour)) continue;
      out.push({
        id_texte: id, date, nature, titre,
        type: /(cessation|révocation|fin de fonctions)/i.test(titre) ? "cessation" : "nomination",
        role: /cabinet|conseiller/i.test(autour) && !/ministre\s/i.test(autour.slice(0, 40)) ? "cabinet" : "ministre",
        civilite: m[0].startsWith("Mme") ? "Mme" : "M.",
        prenom: m[1], nom: m[2],
        fonction: FONCTIONS_CABINET.map((f) => new RegExp(f, "i").exec(autour)).find(Boolean)?.[0] ?? (/ministre/i.test(autour) ? "ministre" : ""),
        portefeuille: (/(Premier ministre|ministre d[e']?\s?[^,.;]{3,80})/i.exec(autour)?.[0] ?? "").replace(/^ministre\s*/i, "").trim(),
        ministre: null,
        extrait: autour,
      });
    }
  }
  const vus = new Set();
  return out.filter((m) => {
    const k = `${m.id_texte}|${cleNom(m.prenom, m.nom)}|${m.type}|${m.role}`;
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
}
