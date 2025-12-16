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
  'prosim', 'dakujem', 'ahoj', 'dobry', 'den'
]);

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
  const brands = [
    'nivea', 'dove', 'rexona', 'axe', 'adidas', 'playboy', 'fa', 'palmolive',
    'head.*shoulders', 'pantene', 'garnier', 'loreal', 'schwarzkopf', 'syoss',
    'colgate', 'oral[\s-]?b', 'sensodyne', 'parodontax',
    'ariel', 'persil', 'jar', 'ajax', 'domestos', 'pur', 'cif', 'vanish',
    'pampers', 'huggies', 'johnson', 'sudocrem'
  ];
  
  for (const brand of brands) {
    const regex = new RegExp(brand, 'i');
    if (regex.test(normalized)) {
      analysis.preferredBrand = brand.replace(/\[.*?\]/g, '').replace(/\\/g, '');
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
 * Skóre 0-100 bodov
 * 
 * ROZLOŽENIE BODOV:
 * - 40 bodov: Zhoda typu produktu (kategória)
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
    targetGroup: 0,      // max 25
    problemSolving: 0,   // max 15
    brandMatch: 0,       // max 10
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
  
  // === 4. ZHODA ZNAČKY (max 10 bodov) ===
  if (analysis.preferredBrand) {
    const brandPattern = new RegExp(analysis.preferredBrand, 'i');
    if (brandPattern.test(brandNorm) || brandPattern.test(titleNorm)) {
      breakdown.brandMatch = 10;
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
// HLAVNÁ VYHĽADÁVACIA FUNKCIA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inteligentné vyhľadávanie produktov s pokročilým skórovaním
 * @param {string} query - Vyhľadávací dotaz
 * @param {Object} options - Možnosti vyhľadávania
 * @returns {Object} - { products, total, query, analysis, needsClarification, clarificationQuestion }
 */
export async function searchProducts(query, options = {}) {
  const { limit = 5, onlyAvailable = true } = options;
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔍 INTELIGENTNÉ VYHĽADÁVANIE');
  console.log('📝 Query:', query);
  
  const products = await getAllProducts();
  
  if (products.length === 0) {
    return { products: [], total: 0, query, analysis: null };
  }
  
  // 1. Analyzuj požiadavku používateľa
  const analysis = analyzeUserRequest(query);
  
  console.log('🎯 Detekovaný typ produktu:', analysis.productType || 'neurčený');
  console.log('👤 Cieľová skupina:', analysis.targetGender || 'neurčená', '/', analysis.targetAgeGroup || 'neurčená');
  console.log('🔧 Problémy:', analysis.problems.length > 0 ? analysis.problems.join(', ') : 'žiadne');
  console.log('🏷️ Preferovaná značka:', analysis.preferredBrand || 'žiadna');
  console.log('💰 Hľadá zľavy:', analysis.wantsDiscount);
  console.log('🔤 Search terms:', analysis.searchTerms.join(', '));
  
  // 2. Skóruj všetky produkty
  const scoredProducts = [];
  let filteredCount = 0;
  
  for (const product of products) {
    // Preskočiť nedostupné ak je filter
    if (onlyAvailable && !product.available) {
      filteredCount++;
      continue;
    }
    
    const result = calculateProductScore(product, analysis);
    
    if (result.isFiltered) {
      filteredCount++;
      continue;
    }
    
    // Minimálne skóre pre relevantné produkty
    const minScore = analysis.productType ? 20 : 10;
    
    if (result.score >= minScore) {
      scoredProducts.push({
        product,
        score: result.score,
        breakdown: result.breakdown
      });
    }
  }
  
  // 3. Zoraď podľa skóre (najvyššie prvé)
  scoredProducts.sort((a, b) => b.score - a.score);
  
  // 4. Vráť top výsledky
  const results = scoredProducts.slice(0, limit).map(s => ({
    ...s.product,
    _score: s.score,
    _breakdown: s.breakdown
  }));
  
  console.log('───────────────────────────────────────────────────────────');
  console.log(`📊 VÝSLEDKY: ${scoredProducts.length} relevantných z ${products.length} (${filteredCount} odfiltrovaných)`);
  
  if (results.length > 0) {
    console.log('🏆 TOP VÝSLEDKY:');
    results.forEach((p, i) => {
      console.log(`   ${i+1}. ${p.title}`);
      console.log(`      Skóre: ${p._score} | Typ: ${p._breakdown.productType} | Skupina: ${p._breakdown.targetGroup} | Problém: ${p._breakdown.problemSolving}`);
    });
  } else {
    console.log('⚠️ Žiadne relevantné výsledky!');
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  
  return {
    products: results,
    total: scoredProducts.length,
    query: query,
    terms: analysis.searchTerms,
    analysis: analysis,
    needsClarification: analysis.needsClarification && results.length === 0,
    clarificationQuestion: analysis.clarificationQuestion
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

