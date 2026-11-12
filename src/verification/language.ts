/**
 * Language coverage for the deterministic skeptic (Attack Lab gap I5). Pure functions, no I/O, no LLM.
 *
 * What this is: a bounded, pattern-based extension of the skeptic.
 *   - COVERED (override-style instructions are recognised): English (prescan.ts), French and Chinese (simplified + traditional), below.
 *   - FAIL-CLOSED for everything else we can recognise as prose: `assessCoverage` reports prose written in a script this scanner cannot
 *     read (Cyrillic, Arabic, Greek, Hindi, Japanese, Korean, ...) or in a Latin-script language it can identify but does not cover
 *     (Spanish, German, Italian, Portuguese, Dutch), or long Latin prose it cannot identify at all. prescan turns that into
 *     UNSCANNED_LANGUAGE (HIGH): a delivery cannot be verified automatically when part of it is text this scanner cannot read.
 *
 * What this is NOT: universal multilingual detection. Covered-language patterns are best-effort fixtures-and-regex, not a classifier;
 * a paraphrase they do not anticipate can evade them. Language identification is a small stop-word heuristic and misjudges short or
 * mixed text. Short values (names, cities, codes) are deliberately NOT treated as prose so ordinary international data is not escalated.
 * Neither check can move money: a flag only escalates to a human (see decideSettlement).
 *
 * Criterion-scoped policy (docs/14 §14.20): which text is language-relevant is decided in scope.ts (what a model can read, and only when the
 * terms contain an LLM-judged criterion); this file classifies one string (`classifyString`) and validates the deployment configuration.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { CONFUSABLES, hasConfusableFinding, skeleton } from "./confusables";

// ---------------------------------------------------------------------------------------------------------------- normalisation
/** Lower-case, accent-folded, apostrophe-normalised: for Latin-script (French) matching only. */
export const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’‘`´]/g, "'");
/** Remove whitespace, punctuation and symbols: Chinese is written without word spaces, so spacing/punctuation must not change a match. */
const HAN = /\p{Script=Han}/u;
const compact = (s: string): string => s.replace(/[\s\p{P}\p{S}]+/gu, "");

// ---------------------------------------------------------------------------------------------------------------- French
const FR_OBJ = "(?:instructions?|consignes?|regles?|directives?|criteres?|verifications?|controles?|validations?|exigences?|contraintes?|restrictions?|conditions?|protocoles?)";
const FR_OVERRIDE_VERB =
  "(?:ignor(?:ez|e|er|ons)|oubli(?:ez|e|er|ons)|contourn(?:ez|e|er)|desobei(?:ssez|s|r)|neglig(?:ez|e|er)|(?:passe[zr]?|passons) outre|outrepass(?:ez|e|er)|fai(?:tes|re|s) abstraction|ne (?:tenez|tiens|tient) pas (?:en )?compte|ne (?:pas )?(?:tenir|prendre|prenez) (?:pas )?(?:en )?compte|ne (?:respectez|suivez|appliquez|verifiez|controlez) pas|ne pas (?:respecter|suivre|appliquer|verifier|controler)|court-?circuit(?:ez|er)|desactiv(?:ez|er))";
const FR_MARK_VERB =
  "(?:marquez|marque|marquer|considerez|considerer|declarez|declarer|jugez|juger|reputez|traitez|comptez|notez|evaluez|validez|valider|approuvez|approuver|acceptez|accepter|mettez|fixez|definissez|reglez|tenez|fai(?:tes|re|s) comme si|supposez que|admettez que|partez du principe que)";
const FR_WORDS = "[\\s\\w',-]";
const FR_RULES: RegExp[] = [
  // ignore / disregard / bypass ... the instructions / rules / checks
  new RegExp(`\\b${FR_OVERRIDE_VERB}\\b${FR_WORDS}{0,40}?\\b${FR_OBJ}\\b`),
  // mark / consider all criteria as met
  new RegExp(`\\b${FR_MARK_VERB}\\b${FR_WORDS}{0,30}?\\b(?:tous|toutes|chaque|l'ensemble|la totalite)\\b${FR_WORDS}{0,25}?\\b(?:criteres?|controles?|verifications?|exigences?|conditions?|points?|elements?|regles?)\\b${FR_WORDS}{0,30}?\\b(?:remplis?|remplies|satisfait[es]?|satisfaisants?|valides?|validees?|reussis?|reussies|respectes?|respectees?|conformes?|ok|passes?|atteints?|acceptes?|acceptees?)\\b`),
  // approve / release this delivery without checking
  new RegExp(`\\b(?:validez|valider|approuvez|approuver|acceptez|accepter|liberez|liberer|debloquez|debloquer|autorisez|autoriser|payez|payer|versez|verser|reglez|certifiez|declarez)\\b${FR_WORDS}{0,30}?\\b(?:livraison|fichier|paiement|reglement|versement|travail|resultat|document|prestation)\\b${FR_WORDS}{0,30}?\\b(?:sans (?:verifier|controler|examiner|relire|tester|verification|controle|examen)|immediatement|sans delai|tout de suite)\\b`),
  // a message addressed to the verifier
  new RegExp(`\\b(?:message|note|avis|attention|instructions?|consigne)\\b${FR_WORDS}{0,20}?\\b(?:verificat(?:eur|rice)s?|relect(?:eur|rice)s?|evaluat(?:eur|rice)s?|examinat(?:eur|rice)s?|correct(?:eur|rice)s?|juges?|auditeurs?|auditrices?|moderat(?:eur|rice)s?)\\b`),
  new RegExp(`\\b(?:cher|chere|chers|cheres)\\s+(?:le |la |l'|les )?(?:verificat(?:eur|rice)s?|relect(?:eur|rice)s?|evaluat(?:eur|rice)s?|examinat(?:eur|rice)s?|correct(?:eur|rice)s?|juges?|auditeurs?|assistants?|modele de langage)\\b`),
  // role prefix ("SYSTEME : ...") at the start of the text or a sentence
  /(?:^|[\n.!?]\s*)(?:systeme|assistant|developpeur|administrateur|admin)\s*:/,
];
/**
 * Filler an attacker can insert between the words of an instruction ("ignorez... toutes *les* instructions"): ellipses, quotes, brackets,
 * markup characters. Replaced by a space. Single . ! ? are KEPT: they end a sentence, and merging sentences would cause false alarms.
 */
export const withoutFiller = (s: string): string => s.replace(/\.{2,}|…|[*_~"“”«»()[\]{}<>|\\/]+/gu, " ");
export function frenchOverride(clean: string): boolean {
  if (!LATIN.test(clean)) return false; // exact gate: every pattern below needs Latin letters
  const f = fold(clean);
  const g = withoutFiller(f);
  return FR_RULES.slice(0, -1).some((re) => re.test(g)) || (FR_RULES.at(-1) as RegExp).test(f);
}

// ---------------------------------------------------------------------------------------------------------------- Chinese
const ZH_OVERRIDE_VERB = "(?:忽略|忽视|忽視|无视|無視|不要理会|不要理會|不必理会|不必理會|不要遵守|不要遵循|不要执行|不要執行|不要按照|不必遵守|无需遵守|無需遵守|别管|別管|绕过|繞過|跳过|跳過|推翻|撇开|撇開|不理会|不理會|置之不理)";
const ZH_OBJ = "(?:指令|指示|规则|規則|标准|標準|条件|條件|检查|檢查|验证|驗證|审核|審核|要求|说明|說明|提示|命令|约束|約束|限制|条款|條款|校验|校驗)";
const ZH_ALL = "(?:所有|全部|每个|每個|一切|各项|各項|每项|每項)";
const ZH_CRIT = "(?:标准|標準|检查|檢查|要求|条件|條件|项目|項目|条目|條目|指标|指標|规则|規則)";
const ZH_MARK = "(?:标记|標記|设置|設置|设为|設為|判定|视为|視為|认定|認定|评为|評為|算作|当作|當作|记为|記為|标为|標為|看作|看成|视作|視作)";
const ZH_PASS = "(?:通过|通過|合格|满足|滿足|达标|達標|完成|符合)";
const ZH_RULES: RegExp[] = [
  new RegExp(`${ZH_OVERRIDE_VERB}.{0,12}?${ZH_OBJ}`),
  new RegExp(`${ZH_MARK}(?:为|成)?.{0,6}?${ZH_ALL}.{0,6}?${ZH_CRIT}.{0,8}?${ZH_PASS}`),
  new RegExp(`${ZH_ALL}(?:的)?${ZH_CRIT}.{0,4}?(?:都|均|皆|全部|一律)?.{0,2}?(?:请|請|要|须|須|必须|必須)?${ZH_MARK}(?:为|成)?(?:已|均已|都已)?${ZH_PASS}`),
  // addressed to the verifier
  /(?:致|亲爱的|親愛的|尊敬的|各位)(?:AI|ai|验证者|驗證者|验证员|驗證員|验证人|驗證人|审核员|审核員|審核員|审核人|審核人|审查员|審查員|评审|評審|评判|評判|评估者|評估者|评分者|評分者|评委|評委|机器人|機器人|助手|助理|大模型|语言模型|語言模型)/,
  /(?:给|給|对|對)(?:验证者|驗證者|验证员|驗證員|验证人|驗證人|审核员|审核員|審核員|审核人|審核人|审查员|審查員|评审|評審|评判|評判|评分者|評分者|评委|評委)/,
  // a polite demand to approve / release
  /(?:请|請|务必|務必|务请|務請)(?:你|您)?(?:直接|立即|立刻|马上|馬上)?(?:放行|批准|释放|釋放|通过|通過|支付|付款|结算|結算|验收|驗收)(?:此|本|该|該|这|這)?(?:个|個)?(?:交付|文件|付款|款项|款項|支付|结果|結果|订单|訂單|工作|交付物)/,
  /(?:给我|給我|请给|請給)(?:满分|滿分|最高分)/,
];
const ZH_ROLE_PREFIX = /(?:^|[。！？.!?\n])\s*(?:系统|系統|助手|助理|开发者|開發者|管理员|管理員)\s*[:：]/;
export function chineseOverride(clean: string): boolean {
  if (!HAN.test(clean)) return false; // exact gate: every pattern below contains Han characters
  if (ZH_ROLE_PREFIX.test(clean)) return true;
  const z = compact(clean);
  return ZH_RULES.some((re) => re.test(z));
}

/** Override-style instructions in the non-English languages this scanner covers (English lives in prescan.ts). */
export const overrideInCoveredLanguages = (clean: string): boolean => frenchOverride(clean) || chineseOverride(clean);

// ---------------------------------------------------------------------------------------------------------------- coverage guard
const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const STOP: Record<string, Set<string>> = {
  en: words("the an and or of to in is are was were be been for with on at by from that this these those it its as not no yes please all any every each you your we our they their he she his her me my have has had do does did will would should can could may must if then than so such into over under between about after before also but how what when where which who why there here more most other some only same too very just file data customer note notes name email column row value values"),
  fr: words("le la les un une des du de et ou est sont etait etaient pour dans sur avec sans par que qui ce cette ces il elle ils elles nous vous je tu ne pas plus tres tout tous toute toutes aussi mais donc si comme au aux en se sa son ses leur leurs mon ma mes ton ta tes notre votre vos nos veuillez"),
};
const OTHER: Record<string, Set<string>> = {
  es: words("el los las una unos unas del por para con como pero muy esta este estos sobre entre sin todos todas porque cuando tambien nada ignora marca al su sus lo ha han fue estan hay donde quien cada otro otra mismo desde hasta mientras segun ser estar"),
  de: words("der die das und ist nicht ein eine einen mit von zu auf fur dem den des im auch sich wird sind bitte alle aber oder wenn als am zum zur vom werden kann konnen ich wir sie bei nach aus uber noch nur schon sehr hat haben wurde wurden mochte"),
  it: words("il gli che non sono con della del dei delle nel nella anche piu tutti tutte questo questa degli sulla dalla al alla alle dal nei sul sui questi quelle hanno essere stato suo sua loro molto ancora cosa"),
  pt: words("os um uma nao para com por mais mas dos das nos nas tambem todos todas isso este esta pelo pela voce sao ser tem foi muito durante ao aos pelos pelas seu sua seus suas ja ainda entre quando onde"),
  nl: words("het een van niet met voor zijn maar ook alle dit deze wordt dat worden heeft hebben naar bij nog zo dan"),
};
const SPACED_SCRIPTS = ["Arabic", "Armenian", "Bengali", "Cyrillic", "Devanagari", "Ethiopic", "Georgian", "Greek", "Gujarati", "Gurmukhi", "Hangul", "Hebrew", "Kannada", "Malayalam", "Sinhala", "Tamil", "Telugu"] as const;
const UNSPACED_SCRIPTS = ["Thai", "Lao", "Khmer", "Myanmar", "Tibetan"] as const;
const SCRIPT_RE = Object.fromEntries([...SPACED_SCRIPTS, ...UNSPACED_SCRIPTS].map((n) => [n, new RegExp(`\\p{Script=${n}}`, "u")]));
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN = /\p{Script=Latin}/u;
const TOKEN = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;

/** Text shorter than this many words (or characters, for unspaced scripts) is treated as data (names, places, codes), not prose. */
const MIN_PROSE_WORDS = 4;
const MIN_PROSE_WORDS_LATIN = 5;
const MIN_UNIDENTIFIED_LATIN_WORDS = 8;
const MIN_UNSPACED_LETTERS = 12;
const MIN_KANA = 8;
/** Prose assembled from several short fields of one row needs more words before it is trusted to be prose (fewer false alarms on address-like rows). */
const MIN_JOINED_WORDS = 6;

const hits = (tokens: string[], list: Set<string>) => tokens.reduce((n, t) => n + (list.has(t) ? 1 : 0), 0);

/** Script of a character, cached by code point (classification depends only on the first letter of a token). "" = not tracked (e.g. Han, covered). */
const SCRIPT_CACHE = new Map<number, string>();
function scriptOf(ch: string): string {
  const cp = ch.codePointAt(0)!;
  const hit = SCRIPT_CACHE.get(cp);
  if (hit !== undefined) return hit;
  let out = "";
  if (KANA.test(ch)) out = "Kana";
  else if (LATIN.test(ch)) out = "Latin";
  else for (const [name, re] of Object.entries(SCRIPT_RE)) if (re.test(ch)) { out = name; break; }
  SCRIPT_CACHE.set(cp, out);
  return out;
}
const UNSPACED = new Set<string>(UNSPACED_SCRIPTS);

function assessSegment(segment: string, joined: boolean, minUnidentified = MIN_UNIDENTIFIED_LATIN_WORDS): string[] {
  const reasons: string[] = [];
  const tokens = segment.match(TOKEN) ?? [];
  const byScript = new Map<string, string[]>();
  let kana = 0;
  const unspaced = new Map<string, number>();
  for (const t of tokens) {
    const script = scriptOf(String.fromCodePoint(t.codePointAt(0)!));
    if (script === "") continue;
    if (script === "Kana") {
      for (const ch of t) if (scriptOf(ch) === "Kana") kana++;
    } else if (UNSPACED.has(script)) {
      unspaced.set(script, (unspaced.get(script) ?? 0) + [...t].length);
    } else {
      (byScript.get(script) ?? byScript.set(script, []).get(script)!).push(t);
    }
  }
  if (kana >= MIN_KANA) reasons.push("script:Japanese");
  for (const [name, n] of unspaced) if (n >= MIN_UNSPACED_LETTERS) reasons.push(`script:${name}`);
  for (const [name, ts] of byScript) {
    const words2 = ts.filter((t) => Array.from(t).length >= 2);
    if (name !== "Latin") {
      if (words2.length >= (joined ? MIN_JOINED_WORDS : MIN_PROSE_WORDS)) reasons.push(`script:${name}`);
      continue;
    }
    // Latin script: English and French are covered; other languages are identified by distinctive stop words.
    const folded = words2.map(fold);
    if (folded.length < (joined ? MIN_JOINED_WORDS : MIN_PROSE_WORDS_LATIN)) continue;
    const en = hits(folded, STOP.en!);
    const fr = hits(folded, STOP.fr!);
    // "-oes" plurals (instrucoes, solucoes) are distinctive Portuguese and break the otherwise frequent Spanish/Portuguese tie.
    const ptPlurals = folded.filter((t) => t.length > 5 && t.endsWith("oes")).length;
    const scored = Object.entries(OTHER).map(([lang, list]) => [lang, hits(folded, list) + (lang === "pt" ? ptPlurals : 0)] as const).sort((a, b) => b[1] - a[1]);
    const [lang, score] = scored[0]!;
    // Spanish, Italian and Portuguese share many function words with French, so a tie with French counts when the distinctive evidence is strong (>= 3).
    if (score >= 2 && (score > Math.max(en, fr) || (score === Math.max(en, fr) && score >= 3))) {
      reasons.push(`language:${lang}`);
      continue;
    }
    // Long Latin prose with no recognisable word in any list. Not for joined rows (addresses), not when it has digits or is mostly capitalised.
    if (!joined && folded.length >= minUnidentified && en + fr + score === 0 && !/\d/.test(segment)) {
      const capitalised = words2.filter((t) => /^\p{Lu}/u.test(t)).length;
      if (capitalised / words2.length < 0.8) reasons.push("unidentified-prose");
    }
  }
  return reasons;
}

/**
 * Returns a short machine-readable reason ("script:Cyrillic", "language:es", "unidentified-prose", comma-joined) when `text` contains
 * prose this scanner cannot read, else null. `joined` marks text assembled from several fields of one row (stricter word threshold).
 * Text is split into sentences first, so a single unreadable sentence inside an otherwise English cell is still found.
 */
export function assessCoverage(text: string, opts: { joined?: boolean; minUnidentified?: number } = {}): string | null {
  if (!text || !text.trim()) return null;
  // Exact shortcut for the overwhelmingly common case (ids, names, emails, dates): ASCII text is Latin script only, and Latin prose needs at least
  // MIN_PROSE_WORDS_LATIN words, i.e. at least 4 gaps between words. Fewer gaps can never be flagged, so skip the analysis.
  if (!opts.joined && !/[^\x00-\x7f]/.test(text) && (text.match(/\s+/g)?.length ?? 0) < MIN_PROSE_WORDS_LATIN - 1) return null;
  const reasons = new Set<string>();
  const parts = opts.joined ? [text] : text.split(/[.!?。！？;；\n\r]+/);
  for (const seg of parts) for (const r of assessSegment(seg, opts.joined === true, opts.minUnidentified)) reasons.add(r);
  return reasons.size ? [...reasons].join(",") : null;
}

// ---------------------------------------------------------------------------------------------------------------- language policy (deployment configuration)
/** Languages the scanner has override-pattern families for. The configuration can only NARROW this set, never invent coverage. */
export const SUPPORTED_LANGUAGE_CODES = ["en", "fr", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGE_CODES)[number];

const policyShape = z
  .object({
    /** languages treated as understood; text in anything else that a model can read is escalated */
    supported: z.array(z.enum(SUPPORTED_LANGUAGE_CODES)).min(1).max(SUPPORTED_LANGUAGE_CODES.length),
    /** "criterion": language rules apply to text a model can read, and only when the terms contain an LLM-judged criterion. "all": every cell, always. */
    scope: z.enum(["criterion", "all"]),
    /** columns withheld from model prompts: their content is not semantically interpreted, so it is exempt from language rules */
    opaqueColumns: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict();
export type LanguagePolicy = z.infer<typeof policyShape>;
export const DEFAULT_LANGUAGE_POLICY: LanguagePolicy = Object.freeze({ supported: ["en", "fr", "zh"], scope: "criterion", opaqueColumns: [] }) as LanguagePolicy;

/** Validate a (possibly partial) policy. Unknown keys, unknown languages, empty supported sets and oversized lists THROW: configuration must never fail open. */
export function parseLanguagePolicy(raw: unknown): LanguagePolicy {
  const p = policyShape.partial().strict().parse(raw ?? {});
  return { supported: [...new Set(p.supported ?? DEFAULT_LANGUAGE_POLICY.supported)], scope: p.scope ?? DEFAULT_LANGUAGE_POLICY.scope, opaqueColumns: [...new Set(p.opaqueColumns ?? [])] };
}

/** MANDATE_SUPPORTED_LANGUAGES="en,fr", MANDATE_LANGUAGE_SCOPE="criterion"|"all", MANDATE_OPAQUE_COLUMNS="name,address". A bad value throws. */
export function languagePolicyFromEnv(env: Record<string, string | undefined>): LanguagePolicy {
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const raw: Record<string, unknown> = {};
  if (env.MANDATE_SUPPORTED_LANGUAGES !== undefined) raw.supported = list(env.MANDATE_SUPPORTED_LANGUAGES);
  if (env.MANDATE_LANGUAGE_SCOPE !== undefined) raw.scope = env.MANDATE_LANGUAGE_SCOPE.trim();
  if (env.MANDATE_OPAQUE_COLUMNS !== undefined) raw.opaqueColumns = list(env.MANDATE_OPAQUE_COLUMNS);
  return parseLanguagePolicy(raw);
}

// ---------------------------------------------------------------------------------------------------------------- override vocabulary in uncovered languages
/** NFKC, then drop zero-width / bidi / tag characters (they are flagged elsewhere; here they must not break a word). */
export const stripInvisible = (s: string): string => s.normalize("NFKC").replace(/[​-‏⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu, "");
/** fold() plus the letters Unicode does not decompose, so a word typed without its diacritics still matches. */
const foldLex = (s: string): string => fold(s).replace(/ł/g, "l").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/đ/g, "d").replace(/ı/g, "i").replace(/æ/g, "ae").replace(/œ/g, "oe");

interface Vocab {
  lang: string;
  /** stems for "ignore / forget / bypass" */
  ignore: string[];
  /** stems for "instructions / rules / criteria / checks" */
  rules: string[];
  /** stems for "approve / release / pay" */
  approve: string[];
  /** stems for "delivery / payment / work / result" */
  targets: string[];
}
/**
 * A KNOWN OVERRIDE-VOCABULARY SCREEN. It recognises an instruction when an "ignore"-class word AND a "rules"-class word (or an "approve"-class word AND
 * a "delivery"-class word) appear in the same string, in 13 languages this scanner otherwise cannot read. Names and ordinary values do not contain such
 * pairs, which is why a short string can be screened without escalating every foreign name.
 * LIMITS, stated plainly: finite word lists written without native-speaker review; a paraphrase that avoids these stems evades it; it says nothing
 * about languages not listed. A leading "=" means the whole word must equal the stem (very short stems).
 */
const RAW_VOCAB: Vocab[] = [
  { lang: "es", ignore: ["ignor", "olvid", "omit", "desobedec", "desestim", "desatiend", "anul", "pasa por alto", "haz caso omiso"], rules: ["instruccion", "regla", "criterios", "verificacion", "requisito", "normas", "directriz", "restriccion"], approve: ["aprueb", "aprob", "autoriz", "libera", "valida", "paga"], targets: ["entrega", "pago", "trabajo", "resultado", "archivo", "documento"] },
  { lang: "de", ignore: ["ignor", "vergiss", "vergess", "missacht", "umgeh", "uberspring", "uberseh", "ubergeh"], rules: ["anweisung", "regel", "kriteri", "prufung", "vorgabe", "instruktion", "anforderung", "richtlinie"], approve: ["genehmig", "freigeb", "gib frei", "bestatig", "akzeptier", "bezahl"], targets: ["lieferung", "zahlung", "arbeit", "ergebnis", "datei", "auftrag"] },
  { lang: "pt", ignore: ["ignor", "esquec", "contorn", "desconsider", "desrespeit", "deixe de lado"], rules: ["instruco", "regra", "criterios", "verificaco", "requisito", "normas", "diretriz"], approve: ["aprov", "autoriz", "valide", "libere", "pague"], targets: ["entrega", "pagamento", "trabalho", "resultado", "arquivo"] },
  { lang: "it", ignore: ["ignor", "dimentic", "aggir", "trascur"], rules: ["istruzion", "regol", "criteri", "controlli", "requisit", "verific", "norme"], approve: ["approv", "convalid", "autorizz", "liber", "pag"], targets: ["consegna", "pagamento", "lavoro", "risultato", "file"] },
  { lang: "nl", ignore: ["negeer", "vergeet", "vergeten", "omzeil", "sla over"], rules: ["instructie", "regel", "criteri", "controle", "vereist", "richtlijn"], approve: ["goedkeur", "keur", "autoriseer", "betaal", "accepteer"], targets: ["levering", "betaling", "werk", "resultaat", "bestand"] },
  { lang: "ru", ignore: ["игнорир", "забуд", "забыв", "пропуст", "обойд", "не учитыв"], rules: ["инструкци", "правил", "критери", "проверк", "требовани", "указани"], approve: ["одобр", "подтверд", "утверд", "оплат", "разреш"], targets: ["достав", "платеж", "оплат", "работ", "результат", "файл", "заказ"] },
  { lang: "pl", ignore: ["ignoru", "zignoru", "zapomn", "pomin", "obejd", "nie zwracaj uwagi"], rules: ["instrukcj", "polecen", "zasad", "kryteri", "wymagan", "regul"], approve: ["zatwierdz", "zaakceptuj", "zaplac", "autoryzuj", "przyjmij"], targets: ["dostaw", "platnosc", "prac", "wynik", "plik"] },
  { lang: "tr", ignore: ["yoksay", "unut", "atla", "dikkate alma", "gormezden gel"], rules: ["talimat", "kural", "kriter", "kontrol", "gereksinim"], approve: ["onayla", "onay", "kabul et"], targets: ["teslimat", "odeme", "sonuc", "dosya", "teslim"] },
  { lang: "id", ignore: ["abaikan", "lupakan", "lewati"], rules: ["instruksi", "aturan", "kriteria", "persyaratan", "pemeriksaan", "ketentuan"], approve: ["setujui", "menyetujui", "terima", "bayar", "izinkan"], targets: ["pengiriman", "pembayaran", "pekerjaan", "hasil", "berkas"] },
  { lang: "ja", ignore: ["無視", "忘れ", "スキップ", "従わな", "守らな"], rules: ["指示", "命令", "ルール", "規則", "基準", "条件", "要件", "チェック", "検査"], approve: ["承認", "許可", "支払", "認め"], targets: ["納品", "支払", "成果物", "結果", "ファイル", "作業"] },
  { lang: "ko", ignore: ["무시", "잊어", "잊으", "건너뛰", "어기"], rules: ["지시", "지침", "규칙", "기준", "조건", "요구", "검사", "명령"], approve: ["승인", "허가", "결제", "지불", "수락"], targets: ["납품", "결제", "결과", "파일", "작업", "주문"] },
  { lang: "ar", ignore: ["تجاهل", "=انس", "تخط", "اهمل"], rules: ["تعليمات", "قواعد", "معايير", "شروط", "متطلبات", "فحص", "اوامر"], approve: ["وافق", "اعتمد", "ادفع", "صادق"], targets: ["التسليم", "الدفع", "النتيجة", "العمل", "الملف", "الطلب"] },
  { lang: "hi", ignore: ["अनदेखा", "नज़रअंदाज़", "नजरअंदाज", "भूल", "छोड़"], rules: ["निर्देश", "नियम", "मानदंड", "शर्त", "जाँच"], approve: ["मंज़ूर", "स्वीकृत", "अनुमोदित", "भुगतान"], targets: ["डिलीवरी", "भुगतान", "काम", "परिणाम", "फ़ाइल"] },
];
const VOCAB = RAW_VOCAB.map((v) => ({ lang: v.lang, ignore: v.ignore.map(foldLex), rules: v.rules.map(foldLex), approve: v.approve.map(foldLex), targets: v.targets.map(foldLex) }));
const hasStem = (f: string, tokens: string[], stems: string[]) => stems.some((s) => (s.startsWith("=") ? tokens.includes(s.slice(1)) : f.includes(s)));

/** The language code whose override vocabulary this text uses (from the 13 above), or null. */
export function lexiconLanguage(text: string): string | null {
  // the text itself, then its confusable SKELETON (final QA B1): a look-alike spelling of an override instruction must hit the same vocabulary
  const direct = lexiconLanguageOf(text);
  if (direct) return direct;
  const sk = skeleton(stripInvisible(text));
  return sk !== text ? lexiconLanguageOf(sk) : null;
}
function lexiconLanguageOf(text: string): string | null {
  const f = foldLex(stripInvisible(text));
  const tokens = f.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kana = KANA.test(f);
  for (const v of VOCAB) {
    if (v.lang === "ja" && !kana) continue; // Han-only text is Chinese, which has its own covered patterns
    if ((hasStem(f, tokens, v.ignore) && hasStem(f, tokens, v.rules)) || (hasStem(f, tokens, v.approve) && hasStem(f, tokens, v.targets))) return v.lang;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------- classification of one string
export interface StringClass {
  /**
   * NOT_LANGUAGE: no letters, or an identifier/email/URL/code. SUPPORTED: identified as a configured covered language. NAME_LIKE: short or
   * proper-noun/address shaped, with no override vocabulary: treated as data. UNSUPPORTED: identified as outside the supported set (language, script
   * or override vocabulary). UNCERTAIN: prose-length text whose language could not be established.
   */
  kind: "NOT_LANGUAGE" | "SUPPORTED" | "NAME_LIKE" | "UNSUPPORTED" | "UNCERTAIN";
  reason?: string;
}
const PARTICLES = new Set(["de", "la", "le", "les", "del", "della", "di", "da", "du", "van", "von", "der", "den", "bin", "ibn", "al", "el", "y", "e", "et", "dos", "das", "do", "des", "ter", "ten", "zu", "zur"]);

/**
 * Classify a string a model may read, short or long. A short string is NOT treated as harmless for being short: it is screened against the override
 * vocabulary above first. Only a short string with no such vocabulary is data. Honest limit: a short instruction that avoids the vocabulary, or in a
 * language outside it, is data to this function (the real defence for such a field is to withhold it from the model: LanguagePolicy.opaqueColumns).
 */
export function classifyString(text: string, policy: LanguagePolicy = DEFAULT_LANGUAGE_POLICY): StringClass {
  const t = stripInvisible(text).replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(t)) return { kind: "NOT_LANGUAGE" };
  // visual spoofing is checked FIRST and structurally (mixed-script word, or a look-alike word inside Latin text): uncertain text is never auto-passed
  if (hasConfusableFinding(t)) return { kind: "UNCERTAIN", reason: "confusable-script" };
  if (!/\s/.test(t) && /^[\x21-\x7e]+$/.test(t) && /[\d@:/_.#%&=+~-]/.test(t)) return { kind: "NOT_LANGUAGE" };
  const vocab = lexiconLanguage(t);
  if (vocab) return { kind: "UNSUPPORTED", reason: `vocabulary:${vocab}` };

  let rest = t;
  if (HAN.test(t)) {
    if (!policy.supported.includes("zh")) return { kind: "UNSUPPORTED", reason: "script:Han" };
    rest = t.replace(/\p{Script=Han}+/gu, " ").trim();
    if (!/\p{L}/u.test(rest)) return { kind: "SUPPORTED" };
  }
  const coverage = assessCoverage(rest, { minUnidentified: 5 });
  if (coverage) return { kind: /script:|language:/.test(coverage) ? "UNSUPPORTED" : "UNCERTAIN", reason: coverage };

  // Identified as English or French? Only meaningful for prose-length text without digits (names and addresses share particles with French).
  const latin = (rest.match(TOKEN) ?? []).filter((w) => LATIN.test(w) && Array.from(w).length >= 2).map(fold);
  if (latin.length >= 4 && !/\d/.test(rest)) {
    const en = hits(latin, STOP.en!);
    const fr = hits(latin, STOP.fr!);
    const lang = en >= 2 && en > fr ? "en" : fr >= 2 && fr > en ? "fr" : null;
    if (lang) return policy.supported.includes(lang) ? { kind: "SUPPORTED", reason: `language:${lang}` } : { kind: "UNSUPPORTED", reason: `language:${lang}` };
  }
  return { kind: "NAME_LIKE" };
}

// ---------------------------------------------------------------------------------------------------------------- detector identity (P7)
/**
 * The identity of THIS detector as shipped in this build (docs/15 section 15.18). A language policy pins (id, version, vocabularyHash); a release in the detector registry
 * is approved for exactly one such triple. The hash covers every DATA table and pattern that decides a classification: the override-vocabulary word lists, the French and
 * Chinese rule patterns (source and flags), the stop-word lists, the script tables, the particles and the numeric thresholds. It does NOT cover the logic of the functions
 * (a function body's text is not stable across compilers); a change of logic must bump DETECTOR_VERSION, and tests/unit/detector-governance.test.ts pins the golden hash so
 * any data change is a deliberate, reviewed act.
 */
export const DETECTOR_ID = "mandate-lexical-detector";
export const DETECTOR_VERSION = "1.1.0";
const sortedSet = (x: Set<string>): string[] => [...x].sort();
const reSig = (r: RegExp): string => r.flags + "/" + r.source;

export function detectorMaterial(): Record<string, unknown> {
  return {
    algorithm: "classifyString/2",
    confusables: Object.entries(CONFUSABLES).sort(([a], [b]) => (a < b ? -1 : 1)),
    frRules: FR_RULES.map(reSig),
    zhRules: ZH_RULES.map(reSig),
    zhRolePrefix: reSig(ZH_ROLE_PREFIX),
    stop: Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, sortedSet(v)])),
    other: Object.fromEntries(Object.entries(OTHER).map(([k, v]) => [k, sortedSet(v)])),
    spacedScripts: [...SPACED_SCRIPTS],
    unspacedScripts: [...UNSPACED_SCRIPTS],
    thresholds: { MIN_PROSE_WORDS, MIN_PROSE_WORDS_LATIN, MIN_UNIDENTIFIED_LATIN_WORDS, MIN_UNSPACED_LETTERS, MIN_KANA, MIN_JOINED_WORDS },
    vocab: RAW_VOCAB,
    particles: sortedSet(PARTICLES),
    supported: [...SUPPORTED_LANGUAGE_CODES],
  };
}
export const detectorVocabularyHash = (): string => "sha256:" + sha256Hex(canonicalJson(detectorMaterial()));
export const shippedDetector = (): { id: string; version: string; vocabularyHash: string } => ({ id: DETECTOR_ID, version: DETECTOR_VERSION, vocabularyHash: detectorVocabularyHash() });
