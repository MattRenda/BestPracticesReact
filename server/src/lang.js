// What language a posting (or an application form) is written in, roughly. HireMe applies in English,
// so roles in other languages are kept out of the deck. Cheap enough to run on every role.

const SCRIPTS = [
  ['ja', /[぀-ヿ]/g], // kana: Japanese (checked before Han)
  ['ko', /[가-힯]/g],
  ['zh', /[一-鿿]/g],
  ['ru', /[Ѐ-ӿ]/g],
  ['ar', /[؀-ۿ]/g],
  ['he', /[֐-׿]/g],
  ['th', /[฀-๿]/g],
  ['hi', /[ऀ-ॿ]/g],
];

// Very common words that are distinctive per language.
const WORDS = {
  en: 'the and you we our are for with will your this that have from about team work',
  de: 'und die der wir sie mit für ist ein eine auf bei unser unsere du dich werden oder auch nicht',
  fr: 'et les des une vous nous pour est dans avec sur notre nos qui sont votre aux pas',
  es: 'y los las una para con por que del nuestro nuestra somos tu eres estamos como más',
  pt: 'e os as uma para com por que do da nosso nossa você somos são não mais',
  nl: 'en de het een wij jij je voor met van zijn onze ons bij niet ook',
  it: 'e il lo gli una per con che del della nostro nostra siamo sei sono non più',
};
const WORD_SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

export const LANGUAGE_NAMES = { en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', ar: 'Arabic', he: 'Hebrew', th: 'Thai', hi: 'Hindi', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese', nl: 'Dutch', it: 'Italian' };

/** 'en', another language code, or '' when there's too little text to tell. */
export function languageOf(text) {
  const t = String(text || '').slice(0, 4000);
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 20) return '';
  // Another script making up more than 15% of the letters decides it (a few Japanese words in an English post don't).
  for (const [code, re] of SCRIPTS) {
    const n = (t.match(re) || []).length;
    if (n / letters > 0.15) return code === 'zh' && /[぀-ヿ]/.test(t) ? 'ja' : code;
  }
  const words = t.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 8) return '';
  const counts = Object.fromEntries(Object.keys(WORD_SETS).map((k) => [k, 0]));
  for (const w of words) for (const k in WORD_SETS) if (WORD_SETS[k].has(w)) counts[k]++;
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  // English unless another language clearly leads.
  return best !== 'en' && n >= 4 && n > counts.en * 1.5 ? best : 'en';
}
