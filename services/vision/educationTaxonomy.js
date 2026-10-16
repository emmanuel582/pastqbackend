// Text normalisation shared by the library. Deliberately knows no exam
// board, institution, country or subject list: classification is done by the
// model (libraryClassifier.js).
const TAXONOMY_VERSION = 5;

/** Lowercase, keep letters and digits of any script, collapse the rest to single spaces. */
function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export { TAXONOMY_VERSION, normalizeText };
