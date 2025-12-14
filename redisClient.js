// redisClient.js
// BM25 vyhľadávací systém pre Upstash Redis
// Optimalizovaný pre slovenské produkty s konverzačným AI prístupom

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

// Hlavná vyhľadávacia funkcia s BM25
export async function searchProducts(query, options = {}) {
  const { 
    limit = 5, 
    category = null, 
    brand = null,
    onlyAvailable = true 
  } = options;
  
  const redis = getRedisClient();
  
  const normalizedQuery = normalizeText(query);
  const queryTerms = normalizedQuery.split(/\s+/).filter(w => w.length >= 2);
  
  if (queryTerms.length === 0) {
    return { products: [], total: 0, query: query };
  }
  
  const N = parseInt(await redis.get('products:count')) || 1;
  const avgDocLen = parseFloat(await redis.get('products:avgDocLen')) || 10;
  
  const wordIndex = {};
  for (const term of queryTerms) {
    const data = await redis.hget('idx:words', term);
    if (data) {
      wordIndex[term] = typeof data === 'string' ? JSON.parse(data) : data;
    }
  }
  
  let candidateIds = new Set();
  for (const term of queryTerms) {
    if (wordIndex[term]) {
      for (const id of Object.keys(wordIndex[term])) {
        candidateIds.add(id);
      }
    }
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
    return { products: [], total: 0, query: query };
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
  
  return {
    products,
    total: scores.length,
    query: query,
    matchedTerms: queryTerms.filter(t => wordIndex[t])
  };
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

