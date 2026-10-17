#!/usr/bin/env node
// jorf-bot — CLI : statut | diagnostique | jour <date> | veille | rattraper | balayer <debut> [fin] | corpus <archive.tar.gz | dossier> <debut> [fin] | indexnow <url>...
// Exemples :
//   node bin/jorf-bot.js statut
//   node bin/jorf-bot.js jour 2026-10-03
//   node bin/jorf-bot.js veille              (5 derniers jours, comme le cron)
//   node bin/jorf-bot.js rattraper           (2017-01-01 → hier)
//   node bin/jorf-bot.js balayer 2024-01-01 2024-06-30
//   node bin/jorf-bot.js balayer 2025-07-14 --forcer   (rattrapage complet, même les jours déjà balayés)
//   node bin/jorf-bot.js corpus Freemium_jorf_global_20250713-140000.tar.gz 2012-01-01 2025-07-13
//   node bin/jorf-bot.js indexnow /gouv /collab/jean-dupont-3f2a1b9c   (soumission manuelle)

import { balayer, importerJour, joursBalayes, statut } from "../src/import.js";
import { importerCorpus } from "../src/corpus.js";
import { fenetreJorfsimple, releverJour } from "../src/jorf.js";
import { ecrire, lire, lirePrive, supprimer } from "../src/supabase.js";
import { verifierEnv } from "../src/supabase.js";
import { notifierIndexNow } from "../src/indexnow.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const aujourdhui = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

// Fenêtre du cron quotidien (veille) : les N derniers jours. Les jours déjà
// balayés (présents dans jorf_releves) sont sautés, seuls les manquants sont
// importés — une matinée de cron manquée (box redémarrée, réseau coupé) est
// donc rattrapée automatiquement aux passages suivants.
const FENETRE_VEILLE = 5;

// Battement de cœur Better Stack : prévenir que le balayage du matin a bien eu
// lieu. URL fournie par BETTERSTACK_HEARTBEAT_URL (monitor de type heartbeat à
// créer côté Better Stack) ; silencieux si la variable est absente. Un échec du
// ping n'invalide pas le balayage lui-même (il a réussi).
async function battement(url) {
  try { await fetch(url); console.log("Heartbeat Better Stack : OK"); }
  catch (e) { console.log(`Heartbeat Better Stack : ÉCHEC — ${e.message}`); }
}

const [commande, ...args] = process.argv.slice(2);

async function main() {
  verifierEnv();
  switch (commande) {
    case "statut": {
      const s = await statut();
      console.log(`Jours balayés : ${s.scan.jours}${s.scan.premiere ? ` (de ${s.scan.premiere} à ${s.scan.derniere})` : ""}`);
      console.log(s.prochain ? `Prochaine étape : ${s.prochain} (${s.restants} jours restants)` : "Historique complet.");
      break;
    }
    case "diagnostique": {
      console.log("== Diagnostique jorf-bot ==");
      console.log(`Date : ${new Date().toISOString()}`);
      // 1) DILA : index JORFSIMPLE (fenêtre glissante des zips disponibles).
      try {
        const f = await fenetreJorfsimple();
        console.log(`DILA index JORFSIMPLE : OK — ${f.nb} zips, de ${f.premier} à ${f.dernier}`);
        console.log(`  (remarque : au-delà de cette fenêtre, les jours « balayés » reviennent vides)`);
      } catch (e) {
        console.log(`DILA index JORFSIMPLE : ÉCHEC — ${e.message}`);
      }
      // 2) DILA : zip de la veille, jusqu'à l'analyse.
      const hier = aujourdhui(1);
      try {
        const mesures = await releverJour(hier);
        console.log(`DILA zip ${hier} : OK — ${mesures.length} mesure(s) nominative(s) extraite(s)`);
      } catch (e) {
        console.log(`DILA zip ${hier} : ÉCHEC — ${e.message}`);
      }
      // 3) Supabase : lecture publique (clé publishable).
      try {
        const rows = await lire("parlementaires", new URLSearchParams({ select: "personne_id", limit: "1" }));
        console.log(`Supabase lecture publique : OK (${rows.length} ligne(s) lue(s))`);
      } catch (e) {
        console.log(`Supabase lecture publique : ÉCHEC — ${e.message}`);
      }
      // 4) Supabase : jorf_releves en lecture service.
      try {
        const rows = await lirePrive("jorf_releves", new URLSearchParams({ select: "date_jorf", order: "date_jorf", limit: "5" }));
        console.log(`jorf_releves lecture : OK (${rows.length} ligne(s))`);
      } catch (e) {
        console.log(`jorf_releves lecture : ÉCHEC — ${e.message}`);
      }
      // 5) Supabase : jorf_releves en écriture (sonde, puis suppression).
      try {
        await ecrire("jorf_releves", [{
          date_jorf: "1970-01-01", nb_mesures: 0, nb_ministres: 0, nb_cabinets: 0,
          erreurs: "sonde diagnostique", synced_at: new Date().toISOString(),
        }]);
        await supprimer("jorf_releves", new URLSearchParams({ date_jorf: "eq.1970-01-01" }));
        console.log("jorf_releves écriture + suppression : OK");
      } catch (e) {
        console.log(`jorf_releves écriture : ÉCHEC — ${e.message}`);
      }
      break;
    }
    case "jour": {
      if (!ISO.test(args[0] ?? "")) { console.error("Usage : jorf-bot jour YYYY-MM-DD"); process.exit(1); }
      console.log(JSON.stringify(await importerJour(args[0]), null, 2));
      break;
    }
    case "veille": {
      // Balayage auto-correctif : les 5 derniers jours, en sautant ceux déjà
      // traités (jorf_releves). Un jour manqué (cron silencieux, box éteinte)
      // est repris au passage suivant — jamais de trou dans la base.
      // Chaque jour importé soumet ses pages à IndexNow (voir import.js) :
      // /gouv, /daily, la fiche du ministre dont le cabinet a bougé et les
      // fiches /collab des collaborateurs concernés.
      const hier = aujourdhui(1);
      const r = await balayer(aujourdhui(FENETRE_VEILLE), hier);
      console.log(`${r.jours.length} jour(s) traité(s), ${r.enErreur ?? 0} en erreur.`);
      // Le battement de cœur n'est envoyé que si hier est bien balayé : si le
      // dump n'était pas encore publié, le run est « incomplet » (code 1) et
      // Better Stack alerte au lieu de valider une matinée ratée.
      const vus = await joursBalayes().catch(() => null);
      if (!vus || !vus.has(hier)) {
        console.error(`Veille incomplète : ${hier} reste à balayer (dump DILA pas encore publié ?)`);
        process.exitCode = 1;
      } else if (process.env.BETTERSTACK_HEARTBEAT_URL) {
        await battement(process.env.BETTERSTACK_HEARTBEAT_URL);
      }
      break;
    }
    case "rattraper": {
      const s = await statut();
      const debut = s.prochain ?? "2017-01-01";
      console.log(`Rattrapage depuis ${debut}…`);
      const r = await balayer(debut, aujourdhui(1));
      console.log(`${r.jours.length} jour(s) traité(s), ${r.enErreur ?? 0} en erreur.`);
      break;
    }
    case "balayer": {
      const forcer = args.includes("--forcer"); // re-balayer même les jours déjà « balayés » (rattrapage après bug)
      const dates = args.filter((a) => ISO.test(a));
      if (!ISO.test(dates[0] ?? "")) { console.error("Usage : jorf-bot balayer YYYY-MM-DD [YYYY-MM-DD] [--forcer]"); process.exit(1); }
      const r = await balayer(dates[0], ISO.test(dates[1] ?? "") ? dates[1] : aujourdhui(1), true, forcer);
      console.log(`${r.jours.length} jour(s) traité(s), ${r.enErreur ?? 0} en erreur.`);
      break;
    }
    case "corpus": {
      if (!args[0] || !ISO.test(args[1] ?? "")) {
        console.error("Usage : jorf-bot corpus <archive.tar.gz | dossier-xml-jorf> YYYY-MM-DD [YYYY-MM-DD]");
        console.error("Import du dump Freemium global DILA (fonds JORF complet) : archive .tar.gz lue en streaming (sans extraction) ou dossier extrait, borne de début, borne de fin (défaut : hier).");
        process.exit(1);
      }
      const fin = ISO.test(args[2] ?? "") ? args[2] : aujourdhui(1);
      const r = await importerCorpus(args[0], args[1], fin);
      console.log(`${r.fichiers} fichier(s) parcouru(s) — ${r.jours} jour(s) importé(s), ${r.mesures} mesure(s) : ${r.ministres} ministre(s), ${r.cabinets} cabinet(s), ${r.erreurs} erreur(s).`);
      break;
    }
    case "indexnow": {
      // Soumission manuelle : chemins absolus du site (/gouv, /daily/2026-10-17…)
      // ou URL complètes. Aucune écriture en base — juste le ping protocole.
      if (!args.length) { console.error("Usage : jorf-bot indexnow <chemin-ou-url>… (ex. /gouv /daily/2026-10-17)"); process.exit(1); }
      const r = await notifierIndexNow(args);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    default:
      console.error("Commandes : statut | diagnostique | jour <date> | veille | rattraper | balayer <debut> [fin] [--forcer] | corpus <archive.tar.gz | dossier> <debut> [fin] | indexnow <url>…");
      process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
