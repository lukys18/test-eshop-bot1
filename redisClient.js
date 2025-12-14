// redisClient.js
// Jednoduchý a spoľahlivý vyhľadávací systém pre produkty

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

// Hlavná vyhľadávacia funkcia
export async function searchProducts(query, options = {}) {
  const { limit = 5, onlyAvailable = true } = options;
  
  console.log('🔍 Vyhľadávam:', query);
  
  const products = await getAllProducts();
  
  if (products.length === 0) {
    return { products: [], total: 0, query };
  }
  
  // Normalizuj query
  const normalizedQuery = normalize(query);
  const queryTerms = normalizedQuery.split(/\s+/).filter(w => w.length >= 2);
  
  console.log('🔤 Hľadané termy:', queryTerms);
  
  if (queryTerms.length === 0) {
    return { products: [], total: 0, query };
  }
  
  // Detekcia cieľovej skupiny v dotaze
  const queryLower = normalizedQuery;
  const forWomen = /(\bpre zeny\b|\bzeny\b|\bzena\b|\bzensky\b|\bdamsk)/i.test(queryLower);
  const forMen = /(\bpre muzov\b|\bmuzov\b|\bmuz\b|\bmuzsky\b|\bpansk)/i.test(queryLower);
  const forKids = /(\bpre deti\b|\bdeti\b|\bdetsk|\bdieta\b|\bbaby\b)/i.test(queryLower);
  
  console.log('👥 Cieľová skupina:', { forWomen, forMen, forKids });
  
  // Bodovanie produktov
  const scored = [];
  
  for (const product of products) {
    // Preskoč nedostupné ak je filter
    if (onlyAvailable && !product.available) continue;
    
    let score = 0;
    const searchText = product.searchText || normalize(`${product.title} ${product.brand} ${product.description} ${product.category}`);
    const titleNorm = normalize(product.title);
    const brandNorm = normalize(product.brand || '');
    
    // Detekcia cieľovej skupiny produktu
    const productForMen = /pre muzov|muzsky|men|man/.test(titleNorm);
    const productForWomen = /pre zeny|zensky|women|woman|girl/.test(titleNorm);
    const productForKids = /pre deti|detsk|kids|baby|dieta/.test(titleNorm);
    
    // Penalizácia za nezhodu cieľovej skupiny
    if (forWomen && productForMen) continue; // Úplne preskočiť produkty pre mužov
    if (forMen && productForWomen) continue; // Úplne preskočiť produkty pre ženy
    if (forKids && !productForKids && (productForMen || productForWomen)) continue;
    
    for (const term of queryTerms) {
      // Presná zhoda v title = 10 bodov
      if (titleNorm.includes(term)) {
        score += 10;
        // Bonus ak je na začiatku
        if (titleNorm.startsWith(term)) score += 5;
      }
      
      // Zhoda v značke = 8 bodov
      if (brandNorm.includes(term)) {
        score += 8;
      }
      
      // Zhoda v searchText (title + brand + description + category) = 3 body
      if (searchText.includes(term)) {
        score += 3;
      }
    }
    
    // Bonus za zhodu cieľovej skupiny
    if (forWomen && productForWomen) score += 15;
    if (forMen && productForMen) score += 15;
    if (forKids && productForKids) score += 15;
    
    // Bonus za zľavu
    if (product.hasDiscount) {
      score += 1;
    }
    
    if (score > 0) {
      scored.push({ product, score });
    }
  }
  
  // Zoraď podľa skóre
  scored.sort((a, b) => b.score - a.score);
  
  // Vráť top výsledky
  const results = scored.slice(0, limit).map(s => ({
    ...s.product,
    _score: s.score
  }));
  
  console.log(`✅ Nájdených ${scored.length} produktov, vrátených ${results.length}`);
  if (results.length > 0) {
    console.log('📋 Top výsledky:', results.slice(0, 3).map(p => `${p.title} (${p._score})`));
  }
  
  return {
    products: results,
    total: scored.length,
    query: query,
    terms: queryTerms
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

// Získanie kategórií
export async function getCategories() {
  const products = await getAllProducts();
  
  const categoryCount = {};
  for (const p of products) {
    const cat = p.categoryMain || 'Ostatné';
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
  }
  
  return Object.entries(categoryCount)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
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

