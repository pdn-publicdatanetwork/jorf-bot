// IndexNow (indexnow.org) : prévenir les moteurs participants (Bing, Yandex,
// Seznam…) qu'une page a été ajoutée, mise à jour ou supprimée, pour qu'ils
// viennent la crawler sans attendre leur propre rythme. Une seule soumission
// suffit : les moteurs participants se partagent automatiquement les URL reçues.
//
// Clé de propriété : fichier public/<clé>.txt servi par la webapp à la racine
// de www.dataparl.fr (option 1 du protocole, répertoire racine). La clé n'est
// pas un secret (elle est publique par conception), INDEXNOW_KEY ne sert qu'à
// la surcharger sans toucher au code.

export const SITE = process.env.INDEXNOW_SITE ?? "https://www.dataparl.fr";
const CLE = process.env.INDEXNOW_KEY ?? "a1b9446d-a1d6-40ce-ba8b-5c5d1bc93b20";
const ENDPOINT = "https://api.indexnow.org/indexnow";

// Soumet un lot d'URL à IndexNow. Les URL acceptées : chemins absolus du site
// ("/gouv", "/collab/<slug>"…) ou URL complètes. Un échec n'est JAMAIS fatal :
// le balayage a déjà réussi, le ping SEO ne doit pas casser la matinée.
// Codes attendus : 200 (clé validée) ou 202 (reçu, validation en cours) ;
// 429 = trop de requêtes — le lendemain sera mieux.
export async function notifierIndexNow(urlList) {
  if (!urlList?.length) return { ok: false, statut: 0, nb: 0, cause: "aucune URL" };
  const urls = [...new Set(urlList)]
    .map((u) => (u.startsWith("http") ? u : SITE + u))
    .slice(0, 10000); // limite protocole
  const reponse = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(SITE).host, key: CLE, urlList: urls }),
  }).catch((e) => ({ status: 0, message: e.message }));
  const ok = reponse.status === 200 || reponse.status === 202;
  if (ok) console.log(`IndexNow : ${urls.length} URL soumise(s) (HTTP ${reponse.status}).`);
  else console.log(`IndexNow : ÉCHEC (HTTP ${reponse.status}${reponse.message ? ` — ${reponse.message}` : ""}) — le balayage n'est pas remis en cause.`);
  return { ok, statut: reponse.status, nb: urls.length };
}
