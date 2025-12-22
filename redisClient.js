// redisClient.js
// Inteligentný produktový vyhľadávací systém s pokročilým skórovaním
// Podľa Claude Opus 4.5 promptu pre Drogeriu

import { Redis } from '@upstash/redis';

let redis = null;
let productsCache = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minúta

export function getRedisClient() {
  if (redis) return redis;
  
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error('Redis not configured');
  }
  
  redis = new Redis({ url, token });
  return redis;
}

// Normalizácia textu (bez diakritiky, lowercase)
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stopwords - slová ktoré ignorujeme pri vyhľadávaní
const STOPWORDS = new Set([
  'pre', 'na', 'do', 'za', 'po', 'od', 'up', 'in', 'on', 'to', 'the', 'and', 'or',
  'som', 'je', 'su', 'ma', 'mi', 'si', 'sa', 'by', 'uz', 'aj', 'no', 'ak', 'ci',
  'hladam', 'potrebujem', 'chcem', 'daj', 'ukazte', 'chcela', 'chcel',
  'nejake', 'nejaky', 'niektore', 'vsetko', 'viac', 'menej',
  'prosim', 'dakujem', 'ahoj', 'dobry', 'den', 'mate', 'máte'
]);

// ═══════════════════════════════════════════════════════════════════════════
// KOMPLETNÝ ZOZNAM ZNAČIEK Z DATABÁZY
// ═══════════════════════════════════════════════════════════════════════════
const ALL_BRANDS = new Set([
  // Normalizované názvy značiek (lowercase, bez diakritiky)
  'a+', 'ace', 'adidas', 'airall', 'airpure', 'airwick', 'ait', 'ajax', 'alex', 'almusso',
  'alpa', 'always', 'ambi pur', 'ambipur', 'antikal', 'apart', 'aquafresh', 'areon', 'ariel',
  'asepso', 'atrix', 'aura', 'aussie', 'axe', 'b.u.', 'bu', 'baba', 'bartek candles', 'bartek',
  'batiste', 'baula', 'bear fruits', 'bel', 'bella', 'bellawa', 'benefit', 'bi-es', 'bies',
  'bielenda', 'bison', 'bispol', 'blend-a-dent', 'blendadent', 'blend-a-med', 'blendamed',
  'blue stratos', 'bolsius', 'bonux', 'borotalco', 'bref', 'bril', 'bros', 'bruno banani',
  'brunobanani', 'brut', 'bubchen', 'buzzy', 'c-thru', 'cthru', 'calgon', 'california scents',
  'carefree', 'carex', 'chanteclair', 'charlotte', 'chemix slovakia', 'chemix', 'chemotox',
  'chicco', 'chupa chups', 'chupachups', 'cif', 'cillit bang', 'cillitbang', 'cillit', 'citra',
  'clean & clear', 'clean clear', 'clean fox', 'cleanfox', 'clin', 'clipper', 'coccolatevi',
  'coccolino', 'colgate', 'corega', 'corri d-italia', 'cosmos', 'coyote', 'curaprox',
  'daily defense', 'dash', 'david beckham', 'davidbeckham', 'beckham', 'deep fresh', 'deepfresh',
  'delfino', 'denim', 'dentek', 'dermomed', 'detox', 'dettol', 'diadermine', 'diamo', 'diffusil',
  'discreet', 'disney', 'doctor m', 'doctor wipes', 'domestos', 'dove', 'dr. beckmann',
  'dr beckmann', 'drbeckmann', 'dr.marcus', 'drmarcus', 'dreft', 'dual power', 'dualpower',
  'duck', 'duha', 'duracell', 'durex', 'duschdas', 'ecoegg', 'elmex', 'elseve', 'eos',
  'euro stil', 'eurostil', 'eveline cosmetics', 'eveline', 'fa', 'fairy', 'falcon', 'febreze',
  'felce azzurra', 'felceazzurra', 'figaro', 'finish', 'fino', 'fixinela', 'floraszept',
  'fre-pro', 'frepro', 'frosch', 'fructis', 'gallus', 'gama', 'garnier', 'george science',
  'gillette', 'glade', 'glanz meister', 'glanzmeister', 'glicemille', 'gliss', 'glisskur',
  'got2b', 'hansaplast', 'harpic', 'hartmann', 'head & shoulders', 'head and shoulders',
  'headshoulders', 'head shoulders', 'herba', 'herbal essences', 'herbal essences pure',
  'herbaria', 'herbavera', 'herr klee', 'herrklee', 'hewa', 'home aroma', 'huggies', 'impulse',
  'indulona', 'intesa', 'ionickiss', 'jack n jill', 'jacknjill', 'jar', 'jelen', 'jest',
  'johnsons', 'johnson', 'jordan', 'kallos', 'kamill', 'kawar', 'kiwi', 'kleenex', 'kneipp',
  'konjac', 'kotex', 'kuschelweich', 'la rive', 'larive', 'labello', 'lacalut', 'lactacyd',
  'lactovit', 'lanza', 'le petit olivier', 'leifheit', 'lenor', 'libresse', 'lifebuoy',
  'listerine', 'little joe', 'littlejoe', 'londa', 'loreal paris', 'loreal', "l'oreal",
  'love beauty & planet', 'love beauty planet', 'lovela', 'lovran', 'lux', 'lysol', 'malizia',
  'masculan', 'meridol', 'mexx', 'milmil', 'mr&mrs', 'mrmrs', 'mr. proper', 'mrproper',
  'mr proper', 'muller', 'nature & more', 'nature more', 'nature box', 'naturebox', 'naturella',
  'nautica voyage', 'nautica', 'neutrogena', 'nfco', 'nickelodeon', 'nicky', 'nivea', 'nodens',
  'normal clinic', 'nova car care', 'o.b.', 'ob', 'odol-med3', 'odolmed3', 'odol', 'off!', 'off',
  'old spice', 'oldspice', 'omo', 'opalescence', 'oral-b', 'oral b', 'oralb', 'orion', 'p&g',
  'pg', 'paclan', 'palette', 'palmolive', 'pampers', 'pantene', 'parodontax', 'passion gold',
  'passiongold', 'penaten', 'persil', 'perwoll', 'pielor', 'piknik', 'pinkfong', 'playboy',
  'pledge', 'pronto', 'protex', 'pulirapid', 'pupa', 'pur', 'purox', 'pusheen', 'raid',
  'reebok', 'rex', 'rexona', 'ria', 'saforelle', 'sagrotan', 'sanytol', 'sapone di toscana',
  'savo', 'schauma', 'schmidts', 'scholl', 'sensodyne', 'septona', 'sidolux', 'signal', 'silan',
  'silkroad', 'sofin', 'softlan', 'sole', 'solo', 'somat', 'spic & span', 'spic span',
  'spuma di sciampagna', 'st. nicolaus', 'stnicolaus', 'str8', 'strep', 'sudocrem', 'surf',
  'syoss', 'taft', 'tento', 'tesori d-oriente', 'tesoridoriente', 'tesori doriente',
  'the pink stuff', 'pinkstuff', 'pink stuff', 'tierra verde', 'tierraverde', 'timotei',
  'tiret', 'tomil', 'toni&guy', 'toniguy', 'toni guy', 'tresemme', 'turtle wax', 'turtlewax',
  'umbro', 'universal', 'vademecum', 'vanish', 'veet', 'vernel', 'vinove', 'wasche meister',
  'waschemeister', 'waschkonig', 'wave', 'wc meister', 'wcmeister', 'weisser riese',
  'weisserriese', 'well done', 'welldone', 'wella', 'wexor', 'wilkinson', 'wojcik', 'woolite',
  'wunder baum', 'wunderbaum', 'zendium', 'zewa', 'ziaja', 'schwarzkopf'
]);

// Krátke značky (1-3 znaky) - potrebujú presný word-boundary match
const SHORT_BRANDS = new Set(['a+', 'ace', 'axe', 'bel', 'bu', 'cif', 'eos', 'fa', 'lux', 'ob', 'off', 'omo', 'pur', 'rex', 'ria', 'e']);

// Funkcia pre kontrolu či slovo je značka
function isBrand(word) {
  const normalized = normalize(word);
  // Pre krátke značky - presná zhoda
  if (normalized.length <= 3) {
    return SHORT_BRANDS.has(normalized);
  }
  return ALL_BRANDS.has(normalized);
}

// Funkcia pre nájdenie značky v texte
function findBrandInText(text) {
  const normalized = normalize(text);
  const words = normalized.split(/\s+/).filter(w => w.length >= 1);
  
  // Najprv skús dvojslovné značky
  for (let i = 0; i < words.length - 1; i++) {
    const twoWords = words[i] + ' ' + words[i + 1];
    if (ALL_BRANDS.has(twoWords)) {
      return twoWords;
    }
  }
  
  // Potom jednoslovné - ale pre krátke značky iba presná zhoda celého slova
  for (const word of words) {
    // Krátke značky (1-3 znaky) - musí byť presná zhoda
    if (word.length <= 3 && SHORT_BRANDS.has(word)) {
      return word;
    }
    // Dlhšie značky (4+ znakov)
    if (word.length >= 4 && ALL_BRANDS.has(word)) {
      return word;
    }
  }
  
  // Skús aj bez medzier (oldspice, headshoulders) - ale len pre dlhšie značky
  for (const brand of ALL_BRANDS) {
    if (brand.length >= 5 && normalized.includes(brand)) {
      return brand;
    }
  }
  
  return null;
}

// Funkcia pre nájdenie VŠETKÝCH značiek v texte
function findAllBrandsInText(text) {
  const normalized = normalize(text);
  const words = normalized.split(/\s+/).filter(w => w.length >= 1);
  const foundBrands = new Set();
  
  // Najprv skús dvojslovné značky
  for (let i = 0; i < words.length - 1; i++) {
    const twoWords = words[i] + ' ' + words[i + 1];
    if (ALL_BRANDS.has(twoWords)) {
      foundBrands.add(twoWords);
    }
  }
  
  // Potom jednoslovné - ale pre krátke značky iba presná zhoda celého slova
  for (const word of words) {
    // Krátke značky (1-3 znaky) - musí byť presná zhoda
    if (word.length <= 3 && SHORT_BRANDS.has(word)) {
      foundBrands.add(word);
    }
    // Dlhšie značky (4+ znakov)
    if (word.length >= 4 && ALL_BRANDS.has(word)) {
      foundBrands.add(word);
    }
  }
  
  // Skús aj bez medzier (oldspice, headshoulders) - ale len pre dlhšie značky
  for (const brand of ALL_BRANDS) {
    if (brand.length >= 5 && normalized.includes(brand)) {
      foundBrands.add(brand);
    }
  }
  
  return Array.from(foundBrands);
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALÝZA CIEĽOVEJ SKUPINY - Extrakcia z produktových dát
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyzuje produkt a extrahuje cieľovú skupinu
 * @param {Object} product - Produktový objekt
 * @returns {Object} - { gender: 'male'|'female'|'unisex', ageGroup: 'kids'|'adult'|'senior' }
 */
function analyzeTargetGroup(product) {
  const title = normalize(product.title || '');
  const description = normalize(product.description || '');
  const category = normalize(product.category || product.categoryMain || '');
  const combined = `${title} ${description} ${category}`;
  
  // === POHLAVIE ===
  let gender = 'unisex';
  
  // Ženské indikátory
  const femalePatterns = /damsk|pre zeny|women|lady|girl|zensky|feminine|damska|diva|princess|pink lady/;
  // Mužské indikátory
  const malePatterns = /pansk|pre muzov|men\b|man\b|muzsky|gentleman|masculine|beard|brady|fuz|barber/;
  // Unisex indikátory (priorita)
  const unisexPatterns = /invisible|universal|unisex|family|rodina|all skin|vsetky typy/;
  
  if (unisexPatterns.test(combined)) {
    gender = 'unisex';
  } else if (femalePatterns.test(combined)) {
    gender = 'female';
  } else if (malePatterns.test(combined)) {
    gender = 'male';
  }
  
  // === VEK ===
  let ageGroup = 'adult';
  
  // Detské indikátory
  const kidsPatterns = /baby|babat|kids|deti|detsk|junior|child|dieta|novorodenc|toddler/;
  // Seniorské indikátory
  const seniorPatterns = /50\+|60\+|anti[\s-]?age|mature|senior|starsi/;
  
  if (kidsPatterns.test(combined)) {
    ageGroup = 'kids';
  } else if (seniorPatterns.test(combined)) {
    ageGroup = 'senior';
  }
  
  return { gender, ageGroup };
}

/**
 * Analyzuje požiadavku používateľa a extrahuje preferencie
 * @param {string} query - Dotaz používateľa
 * @returns {Object} - Preferencie a potreby používateľa
 */
function analyzeUserRequest(query) {
  const normalized = normalize(query);
  const lower = query.toLowerCase();
  
  const analysis = {
    // Cieľová skupina
    targetGender: null,      // male, female, null (neznáme)
    targetAgeGroup: null,    // kids, adult, senior, null
    
    // Typ produktu
    productType: null,       // šampón, krém, dezodorant...
    productCategory: null,   // konkrétna kategória
    
    // Problém/potreba
    problems: [],            // suché vlasy, akné, potenie...
    
    // Preferencie
    preferredBrand: null,    // značka ak je uvedená
    wantsDiscount: false,    // hľadá zľavy
    preferences: [],         // bio, vegan, bez parfumácie...
    
    // Vyhľadávané termy
    searchTerms: [],
    
    // Potrebuje spresnenie
    needsClarification: false,
    clarificationQuestion: null
  };
  
  // === POHLAVIE ===
  if (/pre zenu|zena|zeny|zensky|damsk|manzelk|priatelk|mama|sestra|dcera/i.test(normalized)) {
    analysis.targetGender = 'female';
  } else if (/pre muza|muz\b|muzov|muzsky|pansk|manzel|priatel\b|otec|brat|syn\b/i.test(normalized)) {
    analysis.targetGender = 'male';
  } else if (/pre deti|dieta|dcera|syn|baby|babatk/i.test(normalized)) {
    analysis.targetGender = 'kids'; // Špeciálny prípad
    analysis.targetAgeGroup = 'kids';
  }
  
  // === VEK ===
  if (/det|baby|babat|junior|kids|child/i.test(normalized)) {
    analysis.targetAgeGroup = 'kids';
  } else if (/50\+|60\+|anti[\s-]?age|senior/i.test(normalized)) {
    analysis.targetAgeGroup = 'senior';
  }
  
  // === TYP PRODUKTU ===
  const productTypes = {
    'šampón': /sampon|shampoo/,
    'dezodorant': /dezodorant|deodorant|antiperspirant|sprej.*pod.*pazuch|roll[\s-]?on/,
    'sprchový gél': /sprchov|shower|gel.*sprchan/,
    'mydlo': /mydlo|soap|tuhé.*mydlo/,
    'krém': /krem|cream|moistur|hydrat/,
    'parfém': /parfem|parfum|vonavk|edt|edp|cologne|toaletn.*voda/,
    'zubná pasta': /zubn.*past|toothpaste|pasta.*zuby/,
    'makeup': /make[\s-]?up|mejkap|liceni|ruz\b|riasenka|tiene|pery|rteny|podklad|korektor|puder/,
    'prací prášok': /praci|prasok|pranie|washing|detergent/,
    'aviváž': /avivaz|fabric.*soft|zmakcov/,
    'čistiaci prostriedok': /cistic|cleaner|upratov|cisteni|umyvan/,
    'vlasová starostlivosť': /kondicion|maska.*vlas|serum.*vlas|olej.*vlas|balzam.*vlas/,
    'pleťová starostlivosť': /plet|tvar|facial|serum|tonik|maska.*tvar|cisteni.*plet/,
    'starostlivosť o ruky': /ruk|hand|nail|necht/,
    'starostlivosť o telo': /tel|body|lotion.*tel/,
    'opaľovací krém': /opalov|sunscreen|spf|uv.*ochran/,
    'detská kozmetika': /baby|babat|dets.*krem|dets.*samp/
  };
  
  for (const [type, pattern] of Object.entries(productTypes)) {
    if (pattern.test(normalized)) {
      analysis.productType = type;
      break;
    }
  }
  
  // === PROBLÉMY/POTREBY ===
  const problemPatterns = {
    'suché vlasy': /such.*vlas|dry.*hair|hydrat.*vlas/,
    'mastné vlasy': /mastn.*vlas|oily.*hair|zirn.*vlas/,
    'lupiny': /lupin|dandruff|anti[\s-]?lupin/,
    'vypadávanie vlasov': /vypadav|hair.*loss|padaj.*vlas/,
    'poškodené vlasy': /poskoden|damaged|znicen.*vlas|lam.*vlas/,
    'farbené vlasy': /farben|colored|farba.*vlas/,
    'citlivá pokožka': /citliv|sensitive|jemn.*plet/,
    'suchá pleť': /such.*plet|dry.*skin/,
    'mastná pleť': /mastn.*plet|oily.*skin/,
    'akné': /akne|acne|pupienk|vyraze|problematic/,
    'vrásky': /vrask|wrinkle|anti[\s-]?age|starn/,
    'potenie': /poten|sweat|antiperspi|48.*hod|long.*last/,
    'škvrny na oblečení': /skvrn|stain|invisible|black.*white/,
    'citlivé zuby': /citliv.*zuby|sensitive.*teeth/,
    'bielenie zubov': /biel.*zuby|whitening|white.*teeth/,
    'detská pokožka': /dets.*plet|baby.*skin|jemn.*dets/
  };
  
  for (const [problem, pattern] of Object.entries(problemPatterns)) {
    if (pattern.test(normalized)) {
      analysis.problems.push(problem);
    }
  }
  
  // === PREFERENCIE ===
  const preferencePatterns = {
    'bio': /\bbio\b|organic|prirodn|natural/,
    'vegan': /vegan|cruelty[\s-]?free|bez.*testovania/,
    'bez parfumácie': /bez.*parfum|fragrance[\s-]?free|bez.*vone/,
    'bez alkoholu': /bez.*alkohol|alcohol[\s-]?free/,
    'bez hliníka': /bez.*hlinik|aluminum[\s-]?free|aluminium[\s-]?free/,
    'hypoalergénny': /hypoalergenn|hypoallergenic|pre.*alergik/,
    'dermatologicky testovaný': /dermatolog|tested|testovan/
  };
  
  for (const [pref, pattern] of Object.entries(preferencePatterns)) {
    if (pattern.test(normalized)) {
      analysis.preferences.push(pref);
    }
  }
  
  // === ZNAČKA ===
  // Dvojslovné značky musia byť pred jednoslovnými (kvôli matchovaniu)
  // Používame jednoduché patterny - normalizovaný text má medzery normalizované
  const brands = [
    // Dvojslovné značky (priorita) - hľadáme s medzerou alebo bez
    { pattern: /old\s*spice/i, name: 'old spice' },
    { pattern: /head\s*(and|&)?\s*shoulders/i, name: 'head shoulders' },
    { pattern: /oral[\s-]?b/i, name: 'oral-b' },
    { pattern: /dr\.?\s*beckmann/i, name: 'dr beckmann' },
    { pattern: /king\s*c\b/i, name: 'king c' },
    { pattern: /la\s*roche/i, name: 'la roche' },
    { pattern: /calvin\s*klein/i, name: 'calvin klein' },
    { pattern: /hugo\s*boss/i, name: 'hugo boss' },
    // Jednoslovné značky
    { pattern: /nivea/i, name: 'nivea' },
    { pattern: /dove/i, name: 'dove' },
    { pattern: /rexona/i, name: 'rexona' },
    { pattern: /\baxe\b/i, name: 'axe' },
    { pattern: /adidas/i, name: 'adidas' },
    { pattern: /playboy/i, name: 'playboy' },
    { pattern: /\bfa\b/i, name: 'fa' },
    { pattern: /palmolive/i, name: 'palmolive' },
    { pattern: /pantene/i, name: 'pantene' },
    { pattern: /garnier/i, name: 'garnier' },
    { pattern: /loreal|l'oreal/i, name: 'loreal' },
    { pattern: /schwarzkopf/i, name: 'schwarzkopf' },
    { pattern: /syoss/i, name: 'syoss' },
    { pattern: /schauma/i, name: 'schauma' },
    { pattern: /gliss/i, name: 'gliss' },
    { pattern: /colgate/i, name: 'colgate' },
    { pattern: /sensodyne/i, name: 'sensodyne' },
    { pattern: /parodontax/i, name: 'parodontax' },
    { pattern: /elmex/i, name: 'elmex' },
    { pattern: /ariel/i, name: 'ariel' },
    { pattern: /persil/i, name: 'persil' },
    { pattern: /\bjar\b/i, name: 'jar' },
    { pattern: /\bajax\b/i, name: 'ajax' },
    { pattern: /domestos/i, name: 'domestos' },
    { pattern: /\bpur\b/i, name: 'pur' },
    { pattern: /\bcif\b/i, name: 'cif' },
    { pattern: /vanish/i, name: 'vanish' },
    { pattern: /\bsavo\b/i, name: 'savo' },
    { pattern: /pampers/i, name: 'pampers' },
    { pattern: /huggies/i, name: 'huggies' },
    { pattern: /johnson/i, name: 'johnson' },
    { pattern: /sudocrem/i, name: 'sudocrem' },
    { pattern: /gillette/i, name: 'gillette' },
    { pattern: /duracell/i, name: 'duracell' },
    { pattern: /always/i, name: 'always' },
    { pattern: /durex/i, name: 'durex' }
  ];
  
  for (const brand of brands) {
    if (brand.pattern.test(normalized)) {
      analysis.preferredBrand = brand.name;
      console.log('🏷️ Detekovaná značka:', analysis.preferredBrand);
      break;
    }
  }
  
  // === ZĽAVY ===
  if (/zlav|akci|vypredaj|lacn|promo|sale|znizen|special/i.test(normalized)) {
    analysis.wantsDiscount = true;
  }
  
  // === SEARCH TERMS ===
  analysis.searchTerms = normalized
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));
  
  // === PRODUCT LINE / VARIANT NAME ===
  // Extrahuje názov produktovej línie (napr. "Dynamic Pulse", "Ice Dive", "Fresh Endurance")
  // Toto je kľúčové pre vyhľadávanie konkrétnych variantov produktov
  const productLinePatterns = [
    // Dvojslovné názvy produktových línií (častejšie)
    /\b([a-z]+\s+(?:pulse|dive|game|endurance|cool|fresh|power|active|sport|energy|intense|extreme|classic|original|pure|sensitive|invisible|black|white|gold|silver|platinum))\b/i,
    // Reverzný pattern (prídavné meno + podstatné meno)
    /\b((?:dynamic|ice|fresh|cool|pure|deep|active|sport|power|energy|intense|extreme|ocean|arctic|dark|night|day)\s+[a-z]+)\b/i
  ];
  
  for (const pattern of productLinePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      analysis.productLineName = match[1].trim();
      // Pridaj aj jednotlivé slová z produktovej línie do search terms ak tam ešte nie sú
      const lineWords = analysis.productLineName.split(/\s+/);
      for (const word of lineWords) {
        if (word.length >= 3 && !analysis.searchTerms.includes(word)) {
          analysis.searchTerms.push(word);
        }
      }
      console.log('🏷️ Detekovaný názov produktovej línie:', analysis.productLineName);
      break;
    }
  }
  
  // Ak nebol nájdený pattern, skús extrahovať slová ktoré nie sú značka ani typ produktu
  if (!analysis.productLineName && analysis.preferredBrand) {
    const wordsWithoutBrand = analysis.searchTerms.filter(w => 
      !analysis.preferredBrand.includes(w) && 
      w.length >= 4 &&
      !['sprchov', 'sampon', 'dezodorant', 'krem', 'mydlo', 'parfem', 'gel'].some(t => w.includes(t))
    );
    if (wordsWithoutBrand.length > 0) {
      analysis.productLineName = wordsWithoutBrand.join(' ');
      console.log('🏷️ Extrahovaný potenciálny názov variantu:', analysis.productLineName);
    }
  }
  
  // === POTREBUJE SPRESNENIE? ===
  // Ak nemáme pohlavie ale typ produktu ho vyžaduje
  const genderSensitiveProducts = ['dezodorant', 'parfém', 'sprchový gél'];
  if (!analysis.targetGender && genderSensitiveProducts.includes(analysis.productType)) {
    analysis.needsClarification = true;
    analysis.clarificationQuestion = 'Je to pre muža alebo ženu?';
  }
  
  // Ak je dotaz príliš všeobecný
  if (analysis.searchTerms.length <= 1 && !analysis.productType && !analysis.preferredBrand) {
    analysis.needsClarification = true;
    analysis.clarificationQuestion = 'Mohli by ste upresniť, aký typ produktu hľadáte?';
  }
  
  console.log('📊 Analýza požiadavky:', JSON.stringify(analysis, null, 2));
  
  return analysis;
}

// ═══════════════════════════════════════════════════════════════════════════
// SKÓROVACÍ SYSTÉM - Ranking produktov podľa relevancie
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Vypočíta skóre relevancie produktu voči požiadavke
 * Skóre 0-130 bodov
 * 
 * ROZLOŽENIE BODOV:
 * - 40 bodov: Zhoda typu produktu (kategória)
 * - 30 bodov: Zhoda názvu produktovej línie (napr. "Dynamic Pulse")
 * - 25 bodov: Zhoda pohlavia/cieľovej skupiny
 * - 15 bodov: Riešenie špecifického problému (z description)
 * - 10 bodov: Zhoda značky (ak je preferovaná)
 * - 5 bodov: Akcia/zľava (ak je požadovaná)
 * - 5 bodov: Dostupnosť
 * 
 * @param {Object} product - Produktový objekt
 * @param {Object} analysis - Výsledok analyzeUserRequest
 * @returns {Object} - { score, breakdown, isFiltered }
 */
function calculateProductScore(product, analysis) {
  const breakdown = {
    productType: 0,      // max 40
    productLineMatch: 0, // max 30 - NOVÉ pre názov produktovej línie
    targetGroup: 0,      // max 25
    problemSolving: 0,   // max 15
    brandMatch: 0,       // max 15 - vylepšené matchovanie značky
    discount: 0,         // max 5
    availability: 0,     // max 5
    termMatches: 0,      // bonus za zhodu termov
    penalties: 0         // penalizácie
  };
  
  const titleNorm = normalize(product.title || '');
  const descNorm = normalize(product.description || '');
  const categoryNorm = normalize(product.category || product.categoryMain || '');
  const brandNorm = normalize(product.brand || '');
  const combined = `${titleNorm} ${descNorm} ${categoryNorm} ${brandNorm}`;
  
  // Analýza cieľovej skupiny produktu
  const productTarget = analyzeTargetGroup(product);
  
  // === FILTER: Nedostupné produkty ===
  if (!product.available) {
    return { score: 0, breakdown, isFiltered: true, filterReason: 'Nedostupný' };
  }
  
  // === FILTER: Nesprávne pohlavie ===
  if (analysis.targetGender === 'female' && productTarget.gender === 'male') {
    return { score: 0, breakdown, isFiltered: true, filterReason: 'Nesprávne pohlavie (mužský produkt pre ženu)' };
  }
  if (analysis.targetGender === 'male' && productTarget.gender === 'female') {
    return { score: 0, breakdown, isFiltered: true, filterReason: 'Nesprávne pohlavie (ženský produkt pre muža)' };
  }
  
  // === FILTER: Nesprávna veková skupina (ak je striktne požadovaná) ===
  if (analysis.targetAgeGroup === 'kids' && productTarget.ageGroup !== 'kids') {
    // Miernejší filter - len penalizácia ak nie je detský
    breakdown.penalties -= 15;
  }
  
  // === 1. ZHODA TYPU PRODUKTU (max 40 bodov) ===
  if (analysis.productType) {
    const productTypes = {
      'šampón': /sampon|shampoo/,
      'dezodorant': /dezodorant|deodorant|antiperspirant|roll[\s-]?on|sprej/,
      'sprchový gél': /sprchov|shower|gel/,
      'mydlo': /mydlo|soap/,
      'krém': /krem|cream|moistur/,
      'parfém': /parfem|parfum|vonavk|edt|edp|toaletn.*voda/,
      'zubná pasta': /zubn|toothpaste|pasta/,
      'makeup': /make[\s-]?up|mejkap|liceni|ruz\b|riasenka|tiene|podklad|korektor/,
      'prací prášok': /praci|prasok|pranie|washing/,
      'aviváž': /avivaz|fabric|zmakcov/,
      'čistiaci prostriedok': /cistic|cleaner|upratov/
    };
    
    const typePattern = productTypes[analysis.productType];
    if (typePattern) {
      if (typePattern.test(titleNorm)) {
        breakdown.productType = 40; // Plná zhoda v názve
      } else if (typePattern.test(categoryNorm)) {
        breakdown.productType = 30; // Zhoda v kategórii
      } else if (typePattern.test(combined)) {
        breakdown.productType = 15; // Čiastočná zhoda
      }
    }
  } else {
    // Ak nie je špecifikovaný typ, daj body za zhodu termov v kategórii
    for (const term of analysis.searchTerms) {
      if (categoryNorm.includes(term)) {
        breakdown.productType += 10;
      }
    }
    breakdown.productType = Math.min(breakdown.productType, 40);
  }
  
  // === 2. ZHODA CIEĽOVEJ SKUPINY (max 25 bodov) ===
  if (analysis.targetGender) {
    if (analysis.targetGender === productTarget.gender) {
      breakdown.targetGroup = 25; // Presná zhoda
    } else if (productTarget.gender === 'unisex') {
      breakdown.targetGroup = 15; // Unisex je OK
    }
  } else {
    // Ak nie je špecifikované pohlavie, unisex dostáva bonus
    if (productTarget.gender === 'unisex') {
      breakdown.targetGroup = 10;
    }
  }
  
  // Veková skupina
  if (analysis.targetAgeGroup && analysis.targetAgeGroup === productTarget.ageGroup) {
    breakdown.targetGroup += 10;
  }
  
  breakdown.targetGroup = Math.min(breakdown.targetGroup, 25);
  
  // === 3. RIEŠENIE PROBLÉMU (max 15 bodov) ===
  if (analysis.problems.length > 0) {
    const problemKeywords = {
      'suché vlasy': /such|dry|hydrat|moistur/,
      'mastné vlasy': /mastn|oily|oil[\s-]?control/,
      'lupiny': /lupin|dandruff|anti[\s-]?lupin|head.*shoulders/,
      'vypadávanie vlasov': /vypadav|hair.*loss|posiln|strength/,
      'poškodené vlasy': /poskoden|damaged|repair|oprav/,
      'farbené vlasy': /farben|color|protect|ochra/,
      'citlivá pokožka': /citliv|sensitive|jemn|gentle/,
      'suchá pleť': /such|dry|hydrat/,
      'mastná pleť': /mastn|oily|mattif/,
      'akné': /akne|acne|anti[\s-]?blemish|cistiac/,
      'vrásky': /vrask|wrinkle|anti[\s-]?age|lift|firm/,
      'potenie': /48.*h|antiperspi|dry.*protect|long.*last/,
      'škvrny na oblečení': /invisible|black.*white|stain|bez.*skvrn/,
      'citlivé zuby': /sensitiv|citliv/,
      'bielenie zubov': /whiten|biel|white/
    };
    
    for (const problem of analysis.problems) {
      const pattern = problemKeywords[problem];
      if (pattern && pattern.test(combined)) {
        breakdown.problemSolving += 8;
      }
    }
    breakdown.problemSolving = Math.min(breakdown.problemSolving, 15);
  }
  
  // === 3.5 ZHODA NÁZVU PRODUKTOVEJ LÍNIE (max 30 bodov) - NOVÉ! ===
  // Toto je kľúčové pre vyhľadávanie konkrétnych variantov ako "Dynamic Pulse", "Ice Dive"
  breakdown.productLineMatch = 0;
  if (analysis.productLineName) {
    const lineNorm = normalize(analysis.productLineName);
    const lineWords = lineNorm.split(/\s+/).filter(w => w.length >= 3);
    
    // Celý názov línie v názve produktu = 30 bodov (maximálna relevancia)
    if (titleNorm.includes(lineNorm)) {
      breakdown.productLineMatch = 30;
      console.log(`   🎯 Presná zhoda produktovej línie v názve: "${lineNorm}" -> ${product.title}`);
    } else {
      // Jednotlivé slová z názvu línie
      let matchedWords = 0;
      for (const word of lineWords) {
        if (titleNorm.includes(word)) {
          matchedWords++;
        }
      }
      // Pomerné body za čiastočnú zhodu
      if (matchedWords > 0 && lineWords.length > 0) {
        breakdown.productLineMatch = Math.round((matchedWords / lineWords.length) * 25);
      }
    }
  }
  
  // === 4. ZHODA ZNAČKY (max 15 bodov) - Vylepšené matchovanie ===
  if (analysis.preferredBrand) {
    // Normalizuj značku pre porovnanie (odstráň medzery pre flexibilitu)
    const brandClean = normalize(analysis.preferredBrand).replace(/\s+/g, '');
    const brandWithSpace = normalize(analysis.preferredBrand);
    
    // Kontroluj v brand poli
    const brandNormClean = brandNorm.replace(/\s+/g, '');
    const titleNormClean = titleNorm.replace(/\s+/g, '');
    
    if (brandNorm.includes(brandWithSpace) || brandNormClean.includes(brandClean)) {
      breakdown.brandMatch = 15; // Presná zhoda v brand poli
    } else if (titleNorm.includes(brandWithSpace) || titleNormClean.includes(brandClean)) {
      breakdown.brandMatch = 12; // Zhoda v názve produktu
    } else {
      // Skús jednotlivé slová značky
      const brandWords = brandWithSpace.split(/\s+/).filter(w => w.length >= 3);
      let matchedBrandWords = 0;
      for (const bw of brandWords) {
        if (titleNorm.includes(bw) || brandNorm.includes(bw)) {
          matchedBrandWords++;
        }
      }
      if (matchedBrandWords > 0 && brandWords.length > 0) {
        breakdown.brandMatch = Math.round((matchedBrandWords / brandWords.length) * 10);
      }
    }
  }
  
  // === 5. ZĽAVA (max 5 bodov) ===
  if (product.hasDiscount) {
    if (analysis.wantsDiscount) {
      breakdown.discount = 5; // Plný bonus ak hľadá zľavy
    } else {
      breakdown.discount = 2; // Malý bonus aj tak
    }
  }
  
  // === 6. DOSTUPNOSŤ (max 5 bodov) ===
  if (product.available) {
    breakdown.availability = 5;
  }
  
  // === BONUS: Zhoda vyhľadávacích termov ===
  for (const term of analysis.searchTerms) {
    if (titleNorm.includes(term)) {
      breakdown.termMatches += 5;
    } else if (brandNorm.includes(term)) {
      breakdown.termMatches += 4;
    } else if (combined.includes(term)) {
      breakdown.termMatches += 2;
    }
  }
  
  // === PENALIZÁCIE za preferencie ===
  for (const pref of analysis.preferences) {
    // Ak používateľ chce "bez hliníka" ale produkt ho obsahuje
    if (pref === 'bez hliníka' && /alumin|hlinik/i.test(combined) && !/bez.*alumin|bez.*hlinik|alumin.*free/i.test(combined)) {
      breakdown.penalties -= 20;
    }
    // Podobne pre iné preferencie
    if (pref === 'bez parfumácie' && !/bez.*parfum|fragrance[\s-]?free|bez.*vone/i.test(combined)) {
      breakdown.penalties -= 10;
    }
  }
  
  // === FINÁLNE SKÓRE ===
  const score = Math.max(0, 
    breakdown.productType + 
    breakdown.targetGroup + 
    breakdown.problemSolving + 
    (breakdown.productLineMatch || 0) +  // Nové - zhoda produktovej línie
    breakdown.brandMatch + 
    breakdown.discount + 
    breakdown.availability + 
    breakdown.termMatches + 
    breakdown.penalties
  );
  
  return { score, breakdown, isFiltered: false };
}

// Načítaj všetky produkty (s cache)
async function getAllProducts() {
  const now = Date.now();
  
  // Použij cache ak je čerstvá
  if (productsCache && (now - cacheTime) < CACHE_TTL) {
    return productsCache;
  }
  
  const redis = getRedisClient();
  const data = await redis.get('products:all');
  
  if (!data) {
    console.log('⚠️ Žiadne produkty v databáze');
    return [];
  }
  
  productsCache = typeof data === 'string' ? JSON.parse(data) : data;
  cacheTime = now;
  
  console.log(`📦 Načítaných ${productsCache.length} produktov z Redis`);
  return productsCache;
}

// ═══════════════════════════════════════════════════════════════════════════
// HLAVNÁ VYHĽADÁVACIA FUNKCIA - JEDNODUCHÁ A ROBUSTNÁ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Jednoduché a spoľahlivé vyhľadávanie produktov
 * Používa kompletný zoznam značiek z databázy
 */
export async function searchProducts(query, options = {}) {
  const { limit = 5, onlyAvailable = true } = options;
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔍 VYHĽADÁVANIE:', query);
  
  const products = await getAllProducts();
  
  if (products.length === 0) {
    return { products: [], total: 0, query };
  }
  
  const queryNorm = normalize(query);
  const queryWords = queryNorm.split(/\s+/).filter(w => w.length >= 2 && !STOPWORDS.has(w));
  
  // Detekuj VŠETKY značky v dotaze
  const detectedBrands = findAllBrandsInText(query);
  const detectedBrand = detectedBrands.length > 0 ? detectedBrands[0] : null; // pre spätnú kompatibilitu
  
  console.log('🔤 Vyhľadávacie slová:', queryWords.join(', '));
  console.log('🏷️ Detekované značky:', detectedBrands.length > 0 ? detectedBrands.join(', ') : 'žiadna');
  
  // Skóruj produkty
  const scoredProducts = [];
  
  for (const product of products) {
    // Preskočiť nedostupné
    if (onlyAvailable && !product.available) continue;
    
    const titleNorm = normalize(product.title || '');
    const brandNorm = normalize(product.brand || '');
    const categoryNorm = normalize(product.category || product.categoryMain || '');
    const descNorm = normalize(product.description || '').substring(0, 300);
    const combined = `${titleNorm} ${brandNorm} ${categoryNorm}`;
    
    let score = 0;
    let matchReasons = [];
    
    // === 1. ZHODA ZNAČKY (NAJVYŠŠIA PRIORITA) ===
    // Kontrola všetkých detekovaných značiek
    let brandMatchFound = false;
    for (const brand of detectedBrands) {
      // Presná zhoda značky produktu
      if (brandNorm.includes(brand) || brand.includes(brandNorm)) {
        score += 60;
        matchReasons.push(`značka: ${brand}`);
        brandMatchFound = true;
        break; // Stačí jedna zhoda značky
      }
      // Značka v názve produktu
      else if (titleNorm.includes(brand)) {
        score += 55;
        matchReasons.push(`značka v názve: ${brand}`);
        brandMatchFound = true;
        break;
      }
    }
    
    // === 2. PRESNÁ ZHODA CELÉHO QUERY V NÁZVE ===
    if (queryNorm.length >= 4 && titleNorm.includes(queryNorm)) {
      score += 50;
      matchReasons.push('presná zhoda v názve');
    }
    
    // === 3. ZHODA JEDNOTLIVÝCH SLOV ===
    let wordMatches = 0;
    for (const word of queryWords) {
      if (word.length >= 3 && !isBrand(word)) {
        // Preskočíme značku, tú sme už spracovali
        if (titleNorm.includes(word)) {
          score += 15;
          wordMatches++;
          matchReasons.push(`slovo v názve: ${word}`);
        } else if (categoryNorm.includes(word)) {
          score += 10;
          wordMatches++;
        } else if (descNorm.includes(word)) {
          score += 5;
          wordMatches++;
        }
      }
    }
    
    // === 4. BONUS ZA ZĽAVU ===
    if (product.hasDiscount) {
      score += 3;
    }
    
    // === 5. BONUS ZA VŠETKY SLOVÁ ===
    if (queryWords.length > 1 && wordMatches >= queryWords.length - 1) {
      score += 15;
      matchReasons.push('väčšina slov');
    }
    
    // Minimálne skóre pre zaradenie
    if (score >= 10) {
      scoredProducts.push({
        product,
        score,
        matchReasons
      });
    }
  }
  
  // Zoraď podľa skóre
  scoredProducts.sort((a, b) => b.score - a.score);
  
  // Pri viacerých značkách - zabezpeč zastúpenie každej značky
  let results = [];
  if (detectedBrands.length > 1) {
    // Rozdeľ limit medzi značky
    const perBrandLimit = Math.max(2, Math.ceil(limit / detectedBrands.length));
    const usedProductIds = new Set();
    
    // Pre každú značku vyber top produkty
    for (const brand of detectedBrands) {
      const brandProducts = scoredProducts
        .filter(s => {
          const brandNorm = normalize(s.product.brand || '');
          const titleNorm = normalize(s.product.title || '');
          return (brandNorm.includes(brand) || brand.includes(brandNorm) || titleNorm.includes(brand)) 
                 && !usedProductIds.has(s.product.id);
        })
        .slice(0, perBrandLimit);
      
      for (const sp of brandProducts) {
        usedProductIds.add(sp.product.id);
        results.push({
          ...sp.product,
          _score: sp.score,
          _matchReasons: sp.matchReasons,
          _matchedBrand: brand
        });
      }
    }
    
    // Zoraď výsledky podľa skóre
    results.sort((a, b) => b._score - a._score);
    
    // Orez na limit
    results = results.slice(0, limit);
    
    console.log(`🏷️ Multi-brand search: ${detectedBrands.join(', ')}`);
    console.log(`   Per-brand limit: ${perBrandLimit}, Total results: ${results.length}`);
  } else {
    // Štandardný výber - top výsledky
    results = scoredProducts.slice(0, limit).map(s => ({
      ...s.product,
      _score: s.score,
      _matchReasons: s.matchReasons
    }));
  }
  
  console.log('───────────────────────────────────────────────────────────');
  console.log(`📊 VÝSLEDKY: ${scoredProducts.length} nájdených`);
  
  if (results.length > 0) {
    console.log('🏆 TOP VÝSLEDKY:');
    results.forEach((p, i) => {
      console.log(`   ${i+1}. [${p._score}] ${p.title}${p._matchedBrand ? ` (${p._matchedBrand})` : ''}`);
      console.log(`      Dôvod: ${p._matchReasons?.join(', ') || 'N/A'}`);
    });
  } else {
    console.log('⚠️ Žiadne výsledky pre:', queryWords.join(', '));
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  
  return {
    products: results,
    total: scoredProducts.length,
    query: query,
    terms: queryWords,
    detectedBrand: detectedBrand,
    detectedBrands: detectedBrands
  };
}

// Vyhľadávanie zľavnených produktov
export async function getDiscountedProducts(limit = 5) {
  const products = await getAllProducts();
  
  const discounted = products
    .filter(p => p.hasDiscount && p.available)
    .sort((a, b) => b.discountPercent - a.discountPercent)
    .slice(0, limit);
  
  return discounted;
}

// Získanie kategórií (z Redis cache)
export async function getCategories() {
  const redis = getRedisClient();
  
  // Skús načítať z Redis (vytvorené pri sync)
  const cachedList = await redis.get('categories:list');
  if (cachedList) {
    const list = typeof cachedList === 'string' ? JSON.parse(cachedList) : cachedList;
    console.log(`📂 Načítaných ${list.length} kategórií z cache`);
    return list;
  }
  
  // Fallback - extrahuj z produktov
  const products = await getAllProducts();
  
  const categoryCount = {};
  for (const p of products) {
    const cat = p.categoryMain || 'Ostatné';
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
  }
  
  return Object.entries(categoryCount)
    .map(([name, count]) => ({ level: 1, name, path: name, count }))
    .sort((a, b) => b.count - a.count);
}

// Získanie stromu kategórií
export async function getCategoryTree() {
  const redis = getRedisClient();
  
  const cached = await redis.get('categories:tree');
  if (cached) {
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  }
  
  return null;
}

// Formátuj kategórie pre AI prompt
export async function getCategoriesForPrompt() {
  const categories = await getCategories();
  
  if (!categories || categories.length === 0) {
    return 'Kategórie nie sú dostupné.';
  }
  
  // Zoskup podľa hlavnej kategórie
  const mainCategories = categories.filter(c => c.level === 1);
  const subCategories = categories.filter(c => c.level === 2);
  
  let prompt = 'DOSTUPNÉ KATEGÓRIE V ESHOPE:\n';
  
  for (const main of mainCategories.slice(0, 15)) {
    prompt += `\n📁 ${main.name} (${main.count} produktov)\n`;
    
    // Pridaj podkategórie
    const subs = subCategories
      .filter(s => s.path.startsWith(main.name + ' > '))
      .slice(0, 5);
    
    for (const sub of subs) {
      prompt += `   - ${sub.name} (${sub.count})\n`;
    }
  }
  
  return prompt;
}

// Získanie značiek
export async function getBrands() {
  const products = await getAllProducts();
  
  const brandCount = {};
  for (const p of products) {
    if (p.brand) {
      brandCount[p.brand] = (brandCount[p.brand] || 0) + 1;
    }
  }
  
  return Object.entries(brandCount)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// Štatistiky
export async function getStats() {
  const redis = getRedisClient();
  const products = await getAllProducts();
  const lastUpdate = await redis.get('products:lastUpdate');
  const categories = await getCategories();
  const brands = await getBrands();
  
  return {
    productCount: products.length,
    lastUpdate: lastUpdate || 'unknown',
    categoryCount: categories.length,
    brandCount: brands.length,
    topCategories: categories.slice(0, 5),
    topBrands: brands.slice(0, 5)
  };
}

