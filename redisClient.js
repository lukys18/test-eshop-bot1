// redisClient.js
// Pokročilý vyhľadávací systém pre Upstash Redis
// Optimalizovaný pre slovenské produkty s fuzzy matching a synonymami

import { Redis } from '@upstash/redis';

let redis = null;

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

// BM25 parametre
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Slovenské synonymá pre bežné produktové dotazy
const SYNONYMS = {
  // Čistiace prostriedky
  'sampon': ['šampón', 'šampon', 'sampon', 'vlasový'],
  'gel': ['gél', 'gel', 'sprchový'],
  'krem': ['krém', 'krem', 'krémový'],
  'mydlo': ['mydlo', 'mýdlo'],
  'praci': ['prací', 'praci', 'pranie', 'pracieho'],
  'prasok': ['prášok', 'prasok', 'pracom'],
  'cistic': ['čistič', 'čistiaci', 'cistic', 'cistiaci', 'čistiace'],
  'avivaz': ['aviváž', 'avivaz'],
  
  // Kozmetika
  'dezodorant': ['dezodorant', 'deo', 'antiperspirant', 'antyperspirant'],
  'parfem': ['parfém', 'parfem', 'voňavka', 'voda', 'toaletná'],
  'ruz': ['rúž', 'ruz', 'rtěnka', 'ruž'],
  'makeup': ['makeup', 'make-up', 'líčenie'],
  
  // Hygiena
  'zubna': ['zubná', 'zubna', 'zuby', 'ústna'],
  'pasta': ['pasta', 'pasty'],
  'kefka': ['kefka', 'kartáček', 'zubná kefka'],
  'papier': ['papier', 'toaletný', 'toaletní'],
  'utierky': ['utierky', 'obrúsky', 'vreckovky'],
  
  // Telo
  'vlasy': ['vlasy', 'vlasový', 'vlasová', 'vlasove'],
  'telo': ['telo', 'telovej', 'telový', 'telova'],
  'plet': ['pleť', 'pleťový', 'pleťová', 'plet', 'tvár'],
  'ruky': ['ruky', 'rúk', 'ručný'],
  
  // Domácnosť
  'riad': ['riad', 'riady', 'umývanie', 'jar'],
  'wc': ['wc', 'záchod', 'toaleta', 'toaletný', 'wc čistič'],
  'podlaha': ['podlaha', 'podlahy', 'podlahový'],
  'okno': ['okno', 'okná', 'sklo', 'sklá'],
  'kupelna': ['kúpeľňa', 'kupelna', 'kúpeľ', 'kupel'],
  'kuchyna': ['kuchyňa', 'kuchyna', 'kuchynský', 'kuchynska'],
  
  // Značky (skratky)
  'jar': ['jar', 'clean', 'fresh'],
  'persil': ['persil'],
  'ariel': ['ariel'],
  'nivea': ['nivea'],
  'dove': ['dove'],
  'colgate': ['colgate'],
  'oral': ['oral-b', 'oral', 'oralb'],
  'head': ['head', 'shoulders', 'head&shoulders'],
  'pantene': ['pantene'],
  'garnier': ['garnier'],
  'loreal': ['loréal', 'loreal', "l'oreal"]
};

// Rozšír query o synonymá
function expandQueryWithSynonyms(queryTerms) {
  const expanded = new Set(queryTerms);
  
  for (const term of queryTerms) {
    // Skontroluj či term matchuje nejaké synonymum
    for (const [key, synonyms] of Object.entries(SYNONYMS)) {
      const normalizedKey = normalizeText(key);
      const normalizedSynonyms = synonyms.map(s => normalizeText(s));
      
      if (normalizedKey === term || normalizedSynonyms.includes(term) || 
          normalizedKey.includes(term) || term.includes(normalizedKey)) {
        expanded.add(normalizedKey);
        normalizedSynonyms.forEach(s => expanded.add(s));
      }
    }
  }
  
  return [...expanded];
}

// Hlavná vyhľadávacia funkcia s BM25 + fuzzy matching + synonymá
export async function searchProducts(query, options = {}) {
  const { 
    limit = 5, 
    category = null, 
    brand = null,
    onlyAvailable = true,
    fuzzyMatch = true
  } = options;
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔎 VYHĽADÁVANIE:', { query, options });
  
  const redis = getRedisClient();
  
  const normalizedQuery = normalizeText(query);
  let queryTerms = normalizedQuery.split(/\s+/).filter(w => w.length >= 2);
  
  console.log('🔤 Originálne termy:', queryTerms);
  
  // Rozšír o synonymá
  const expandedTerms = expandQueryWithSynonyms(queryTerms);
  console.log('🔄 Po rozšírení synonymami:', expandedTerms);
  
  if (expandedTerms.length === 0) {
    console.log('⚠️ Žiadne platné termy');
    return { products: [], total: 0, query: query, matchedTerms: [] };
  }
  
  const N = parseInt(await redis.get('products:count')) || 1;
  const avgDocLen = parseFloat(await redis.get('products:avgDocLen')) || 10;
  
  console.log('📊 Databáza:', { produktov: N, priemerDĺžkaDok: avgDocLen });
  
  // Získaj word index
  const wordIndex = {};
  const matchedTerms = [];
  const allIndexWords = await redis.hkeys('idx:words') || [];
  
  console.log(`📚 Index obsahuje ${allIndexWords.length} unikátnych slov`);
  
  for (const term of expandedTerms) {
    // Presná zhoda
    const data = await redis.hget('idx:words', term);
    if (data) {
      wordIndex[term] = typeof data === 'string' ? JSON.parse(data) : data;
      matchedTerms.push(term);
      console.log(`✅ "${term}" - presná zhoda, ${Object.keys(wordIndex[term]).length} produktov`);
    } else if (fuzzyMatch && term.length >= 3) {
      // Fuzzy matching - hľadaj slová ktoré obsahujú term alebo term obsahuje ich
      for (const indexWord of allIndexWords) {
        // Bezpečnostná kontrola - musí byť string
        if (typeof indexWord !== 'string') continue;
        
        if (indexWord.includes(term) || term.includes(indexWord)) {
          const fuzzyData = await redis.hget('idx:words', indexWord);
          if (fuzzyData) {
            const parsed = typeof fuzzyData === 'string' ? JSON.parse(fuzzyData) : fuzzyData;
            if (!wordIndex[indexWord]) {
              wordIndex[indexWord] = parsed;
              matchedTerms.push(`${term}~${indexWord}`);
              console.log(`🔍 "${term}" -> fuzzy match "${indexWord}", ${Object.keys(parsed).length} produktov`);
            }
          }
        }
      }
    }
  }
  
  // Ak stále nič, skús prefix matching
  if (Object.keys(wordIndex).length === 0 && queryTerms.length > 0) {
    console.log('🔄 Skúšam prefix matching...');
    for (const term of queryTerms) {
      if (term.length >= 2) {
        for (const indexWord of allIndexWords.slice(0, 500)) { // Limit pre rýchlosť
          // Bezpečnostná kontrola
          if (typeof indexWord !== 'string') continue;
          
          if (indexWord.startsWith(term) || term.startsWith(indexWord)) {
            const prefixData = await redis.hget('idx:words', indexWord);
            if (prefixData && !wordIndex[indexWord]) {
              const parsed = typeof prefixData === 'string' ? JSON.parse(prefixData) : prefixData;
              wordIndex[indexWord] = parsed;
              matchedTerms.push(`${term}≈${indexWord}`);
              console.log(`📎 "${term}" -> prefix match "${indexWord}", ${Object.keys(parsed).length} produktov`);
            }
          }
        }
      }
    }
  }
  
  let candidateIds = new Set();
  for (const term of Object.keys(wordIndex)) {
    for (const id of Object.keys(wordIndex[term])) {
      candidateIds.add(id);
    }
  }
  
  console.log('📋 Kandidátov po word matching:', candidateIds.size);
  
  // Ak stále nemáme kandidátov, skús fulltext scan (pomalšie, ale spoľahlivé)
  if (candidateIds.size === 0 && queryTerms.length > 0) {
    console.log('🔄 Spúšťam fulltext fallback scan...');
    const allIds = await redis.smembers('products:ids') || [];
    
    for (const id of allIds.slice(0, 200)) { // Limit pre rýchlosť
      const product = await redis.get(`p:${id}`);
      if (product) {
        const p = typeof product === 'string' ? JSON.parse(product) : product;
        const productText = normalizeText(`${p.title} ${p.brand} ${p.description} ${p.category}`);
        
        for (const term of queryTerms) {
          if (productText.includes(term)) {
            candidateIds.add(id);
            matchedTerms.push(`fulltext:${term}`);
            break;
          }
        }
      }
    }
    console.log('📋 Kandidátov po fulltext scan:', candidateIds.size);
  }
  
  if (category) {
    const catData = await redis.hget('idx:categories', normalizeText(category));
    if (catData) {
      const catIds = new Set(typeof catData === 'string' ? JSON.parse(catData) : catData);
      candidateIds = new Set([...candidateIds].filter(id => catIds.has(id)));
    }
  }
  
  if (brand) {
    const brandData = await redis.hget('idx:brands', normalizeText(brand));
    if (brandData) {
      const brandIds = new Set(typeof brandData === 'string' ? JSON.parse(brandData) : brandData);
      candidateIds = new Set([...candidateIds].filter(id => brandIds.has(id)));
    }
  }
  
  if (candidateIds.size === 0) {
    console.log('⚠️ Žiadni kandidáti, vraciam prázdny výsledok');
    return { products: [], total: 0, query: query, matchedTerms: [] };
  }
  
  const docLengths = {};
  const candidateArray = [...candidateIds];
  for (let i = 0; i < candidateArray.length; i += 100) {
    const batch = candidateArray.slice(i, i + 100);
    for (const id of batch) {
      const len = await redis.hget('idx:docLengths', id);
      docLengths[id] = parseInt(len) || avgDocLen;
    }
  }
  
  const scores = [];
  for (const docId of candidateIds) {
    let score = 0;
    const docLen = docLengths[docId] || avgDocLen;
    
    for (const term of queryTerms) {
      const termDocs = wordIndex[term];
      if (!termDocs || !termDocs[docId]) continue;
      
      const tf = termDocs[docId];
      const df = Object.keys(termDocs).length;
      
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
      
      score += idf * tfNorm;
    }
    
    if (score > 0) {
      scores.push({ id: docId, score });
    }
  }
  
  scores.sort((a, b) => b.score - a.score);
  const topResults = scores.slice(0, limit * 2);
  
  const products = [];
  for (const { id, score } of topResults) {
    const data = await redis.get(`p:${id}`);
    if (data) {
      const product = typeof data === 'string' ? JSON.parse(data) : data;
      if (onlyAvailable && !product.available) continue;
      products.push({ ...product, _score: score });
      if (products.length >= limit) break;
    }
  }
  
  console.log('📊 Výsledky vyhľadávania:', {
    celkovo: scores.length,
    vrátených: products.length,
    matchedTerms: matchedTerms,
    topProdukty: products.slice(0, 3).map(p => ({ title: p.title, score: p._score?.toFixed(2) }))
  });
  
  console.log('═══════════════════════════════════════════════════════════');
  
  return {
    products,
    total: scores.length,
    query: query,
    matchedTerms: matchedTerms
  };
}

// Vyhľadávanie podľa kategórie
export async function searchByCategory(categoryName, limit = 5) {
  const redis = getRedisClient();
  const normalizedCat = normalizeText(categoryName);
  
  // Najprv skús presnú zhodu
  let catData = await redis.hget('idx:categories', normalizedCat);
  
  // Ak nie, skús partial match
  if (!catData) {
    const allCats = await redis.hkeys('idx:categories') || [];
    for (const cat of allCats) {
      if (cat.includes(normalizedCat) || normalizedCat.includes(cat)) {
        catData = await redis.hget('idx:categories', cat);
        if (catData) break;
      }
    }
  }
  
  if (!catData) return [];
  
  const ids = typeof catData === 'string' ? JSON.parse(catData) : catData;
  const products = [];
  
  for (const id of ids.slice(0, limit)) {
    const product = await getProductById(id);
    if (product && product.available) {
      products.push(product);
    }
  }
  
  return products;
}

// Vyhľadávanie podľa značky
export async function searchByBrand(brandName, limit = 5) {
  const redis = getRedisClient();
  const normalizedBrand = normalizeText(brandName);
  
  let brandData = await redis.hget('idx:brands', normalizedBrand);
  
  if (!brandData) {
    const allBrands = await redis.hkeys('idx:brands') || [];
    for (const brand of allBrands) {
      if (brand.includes(normalizedBrand) || normalizedBrand.includes(brand)) {
        brandData = await redis.hget('idx:brands', brand);
        if (brandData) break;
      }
    }
  }
  
  if (!brandData) return [];
  
  const ids = typeof brandData === 'string' ? JSON.parse(brandData) : brandData;
  const products = [];
  
  for (const id of ids.slice(0, limit)) {
    const product = await getProductById(id);
    if (product && product.available) {
      products.push(product);
    }
  }
  
  return products;
}

// Získanie kategórií pre konverzačný AI
export async function getCategories() {
  const redis = getRedisClient();
  const catData = await redis.hgetall('idx:categories');
  
  if (!catData) return [];
  
  const categories = [];
  for (const [name, ids] of Object.entries(catData)) {
    const idList = typeof ids === 'string' ? JSON.parse(ids) : ids;
    categories.push({
      name: name,
      count: idList.length
    });
  }
  
  return categories.sort((a, b) => b.count - a.count);
}

// Získanie značiek
export async function getBrands() {
  const redis = getRedisClient();
  const brandData = await redis.hgetall('idx:brands');
  
  if (!brandData) return [];
  
  const brands = [];
  for (const [name, ids] of Object.entries(brandData)) {
    const idList = typeof ids === 'string' ? JSON.parse(ids) : ids;
    brands.push({
      name: name,
      count: idList.length
    });
  }
  
  return brands.sort((a, b) => b.count - a.count);
}

// Získanie produktu podľa ID
export async function getProductById(id) {
  const redis = getRedisClient();
  const data = await redis.get(`p:${id}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

// Získanie náhodných produktov z kategórie
export async function getRandomFromCategory(category, limit = 3) {
  const redis = getRedisClient();
  const catData = await redis.hget('idx:categories', normalizeText(category));
  
  if (!catData) return [];
  
  const ids = typeof catData === 'string' ? JSON.parse(catData) : catData;
  const shuffled = ids.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, limit);
  
  const products = [];
  for (const id of selected) {
    const product = await getProductById(id);
    if (product && product.available) {
      products.push(product);
    }
  }
  
  return products;
}

// Zistenie zľavnených produktov
export async function getDiscountedProducts(limit = 5) {
  const redis = getRedisClient();
  const allIds = await redis.smembers('products:ids');
  
  const discounted = [];
  for (const id of allIds) {
    if (discounted.length >= limit * 3) break;
    const product = await getProductById(id);
    if (product && product.hasDiscount && product.available) {
      discounted.push(product);
    }
  }
  
  discounted.sort((a, b) => b.discountPercent - a.discountPercent);
  return discounted.slice(0, limit);
}

// Štatistiky databázy
export async function getStats() {
  const redis = getRedisClient();
  
  const count = await redis.get('products:count');
  const lastUpdate = await redis.get('products:lastUpdate');
  const categories = await getCategories();
  const brands = await getBrands();
  
  return {
    productCount: parseInt(count) || 0,
    lastUpdate: lastUpdate || 'unknown',
    categoryCount: categories.length,
    brandCount: brands.length,
    topCategories: categories.slice(0, 5),
    topBrands: brands.slice(0, 5)
  };
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

