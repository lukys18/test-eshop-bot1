// api/syncXML.js
// Vercel Serverless Function pre synchronizáciu XML produktov do Upstash Redis
// Optimalizovaný pre BM25 vyhľadávanie a hierarchické kategórie

import axios from 'axios';
import xml2js from 'xml2js';
import { Redis } from '@upstash/redis';

const BATCH_SIZE = 100;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const XML_URL = process.env.XML_URL;
  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!XML_URL) return res.status(500).json({ error: 'XML_URL not configured' });
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: 'Upstash Redis not configured' });
  }

  const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  const isCronJob = req.headers['x-vercel-cron'] === '1';
  console.log(isCronJob ? '⏰ Cron job spustený' : '🔄 Manuálny sync spustený');

  try {
    const startTime = Date.now();

    console.log(`📥 Sťahujem XML z: ${XML_URL}`);
    const xmlData = await fetchAndParseXML(XML_URL);
    
    const rawProducts = extractProducts(xmlData);
    console.log(`📦 Extrahovaných ${rawProducts.length} produktov`);

    if (rawProducts.length === 0) {
      return res.status(400).json({ error: 'No products found in XML' });
    }

    const products = rawProducts.map(transformProduct);
    console.log(`✅ Transformovaných ${products.length} produktov`);

    await saveProductsAndBuildIndex(redis, products);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Sync dokončený za ${duration}s`);

    return res.status(200).json({
      success: true,
      message: `Synced ${products.length} products`,
      timestamp: new Date().toISOString(),
      duration: `${duration}s`
    });

  } catch (error) {
    console.error('❌ Sync error:', error);
    return res.status(500).json({ error: 'Sync failed', details: error.message });
  }
}

async function fetchAndParseXML(url) {
  const response = await axios.get(url, {
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    maxContentLength: 200 * 1024 * 1024,
  });

  const parser = new xml2js.Parser({
    explicitArray: false,
    ignoreAttrs: false,
    mergeAttrs: true
  });

  return parser.parseStringPromise(response.data);
}

function extractProducts(xmlData) {
  if (xmlData.rss?.channel?.item) {
    const items = xmlData.rss.channel.item;
    return Array.isArray(items) ? items : [items];
  }
  return [];
}

function decodeHtmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&yacute;/g, 'ý')
    .replace(/&iacute;/g, 'í')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&scaron;/g, 'š')
    .replace(/&ccaron;/g, 'č')
    .replace(/&zcaron;/g, 'ž')
    .replace(/&ncaron;/g, 'ň')
    .replace(/&tcaron;/g, 'ť')
    .replace(/&dcaron;/g, 'ď')
    .replace(/&lcaron;/g, 'ľ')
    .replace(/&rcaron;/g, 'ŕ')
    .replace(/&ocircumflex;/g, 'ô')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function transformProduct(raw) {
  const id = raw['g:id'] || `p_${Math.random().toString(36).substr(2, 9)}`;
  const title = decodeHtmlEntities(raw['g:title'] || '');
  const description = decodeHtmlEntities(raw['g:description'] || '').substring(0, 300);
  
  const priceStr = raw['g:price'] || '0';
  const price = parseFloat(String(priceStr).replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
  
  const salePriceStr = raw['g:sale_price'];
  const salePrice = salePriceStr ? 
    parseFloat(String(salePriceStr).replace(/[^\d.,]/g, '').replace(',', '.')) : null;

  const categoryFull = decodeHtmlEntities(raw['g:product_type'] || raw['g:google_product_category'] || '');
  const categoryParts = categoryFull.split('|').map(s => s.trim()).filter(Boolean);
  
  const brand = decodeHtmlEntities(raw['g:brand'] || '');
  const available = String(raw['g:availability'] || '').toLowerCase().includes('in stock');
  
  // Správne extrahuj URL - môže byť objekt alebo string
  let image = raw['g:image_link'];
  if (typeof image === 'object' && image !== null) {
    image = image._ || image['#text'] || String(image);
  }
  
  let url = raw['g:link'];
  if (typeof url === 'object' && url !== null) {
    url = url._ || url['#text'] || String(url);
  }
  url = url ? String(url).trim() : null;

  return {
    id: String(id),
    title,
    description,
    price,
    salePrice,
    hasDiscount: salePrice && salePrice < price,
    discountPercent: salePrice && salePrice < price ? Math.round((1 - salePrice / price) * 100) : 0,
    category: categoryFull,
    categoryPath: categoryParts,
    categoryMain: categoryParts[0] || '',
    categorySub: categoryParts.slice(1).join(' > ') || '',
    brand,
    available,
    image,
    url
  };
}

async function saveProductsAndBuildIndex(redis, products) {
  console.log('🧹 Začínam čistenie starých dát...');
  
  // Vymaž VŠETKY staré dáta - kompletný reset
  const oldIds = await redis.smembers('products:ids') || [];
  console.log(`🗑️ Mažem ${oldIds.length} starých produktov`);
  
  if (oldIds.length > 0) {
    // Maž v dávkach po 100
    for (let i = 0; i < oldIds.length; i += 100) {
      const batch = oldIds.slice(i, i + 100);
      const pipeline = redis.pipeline();
      for (const id of batch) {
        pipeline.del(`p:${id}`);
      }
      await pipeline.exec();
    }
  }
  
  // Vymaž všetky indexy
  console.log('🗑️ Mažem staré indexy...');
  await redis.del('products:ids');
  await redis.del('products:count');
  await redis.del('products:avgDocLen');
  await redis.del('idx:words');
  await redis.del('idx:categories');
  await redis.del('idx:brands');
  await redis.del('idx:docLengths');
  
  console.log('✅ Staré dáta vymazané, začínam ukladať nové produkty...');
  
  const wordIndex = new Map();
  const categoryIndex = new Map();
  const brandIndex = new Map();
  const docLengths = new Map();
  let totalDocLength = 0;

  const pipeline = redis.pipeline();
  
  // Slovenské synonymá pre lepšie vyhľadávanie
  const SYNONYMS = {
    'sampon': ['šampón', 'šampon', 'sampon'],
    'sampon': ['šampón', 'šampon', 'sampon'],
    'gel': ['gél', 'gel'],
    'krem': ['krém', 'krem'],
    'mydlo': ['mydlo', 'mýdlo'],
    'praci': ['prací', 'praci'],
    'prasok': ['prášok', 'prasok'],
    'cistic': ['čistič', 'čistiaci', 'cistic', 'cistiaci'],
    'avivaž': ['aviváž', 'avivaz'],
    'dezodorant': ['dezodorant', 'deo', 'antiperspirant'],
    'parfem': ['parfém', 'parfem', 'voňavka'],
    'zubna': ['zubná', 'zubna'],
    'pasta': ['pasta'],
    'vlasy': ['vlasy', 'vlasový', 'vlasova'],
    'telo': ['telo', 'telovej', 'telový'],
    'riad': ['riad', 'riady', 'umývanie'],
    'wc': ['wc', 'záchod', 'toaleta', 'toaletný'],
    'podlaha': ['podlaha', 'podlahy', 'podlahový'],
    'okno': ['okno', 'okná', 'sklo'],
    'kupelna': ['kúpeľňa', 'kupelna', 'kúpeľ'],
    'kuchyna': ['kuchyňa', 'kuchyna', 'kuchynský']
  };
  
  for (const product of products) {
    pipeline.set(`p:${product.id}`, JSON.stringify(product));
    
    // Rozšírený searchText - zahŕňa všetko dôležité
    const searchParts = [
      product.title,
      product.title, // Zdvojnásobiť title pre väčšiu váhu
      product.brand,
      product.brand, // Zdvojnásobiť brand
      product.description || '',
      product.categoryMain || '',
      ...(product.categoryPath || []),
      product.categorySub || ''
    ];
    
    const searchText = searchParts.join(' ').toLowerCase();
    let words = normalizeText(searchText).split(/\s+/).filter(w => w.length >= 2);
    
    // Pridaj synonymá
    const extraWords = [];
    for (const word of words) {
      for (const [key, synonyms] of Object.entries(SYNONYMS)) {
        if (synonyms.some(s => normalizeText(s) === word || word.includes(normalizeText(s)))) {
          extraWords.push(key);
          synonyms.forEach(s => extraWords.push(normalizeText(s)));
        }
      }
    }
    words = [...new Set([...words, ...extraWords])];
    
    docLengths.set(product.id, words.length);
    totalDocLength += words.length;
    
    const wordFreq = new Map();
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
    
    for (const [word, freq] of wordFreq) {
      if (!wordIndex.has(word)) {
        wordIndex.set(word, new Map());
      }
      wordIndex.get(word).set(product.id, freq);
    }
    
    if (product.categoryMain) {
      const catKey = normalizeText(product.categoryMain);
      if (!categoryIndex.has(catKey)) {
        categoryIndex.set(catKey, new Set());
      }
      categoryIndex.get(catKey).add(product.id);
    }
    
    if (product.brand) {
      const brandKey = normalizeText(product.brand);
      if (!brandIndex.has(brandKey)) {
        brandIndex.set(brandKey, new Set());
      }
      brandIndex.get(brandKey).add(product.id);
    }
  }
  
  pipeline.del('products:ids');
  const allIds = products.map(p => p.id);
  if (allIds.length > 0) {
    pipeline.sadd('products:ids', ...allIds);
  }
  
  pipeline.set('products:count', products.length);
  pipeline.set('products:avgDocLen', totalDocLength / products.length);
  pipeline.set('products:lastUpdate', new Date().toISOString());
  
  await pipeline.exec();
  
  await saveIndex(redis, 'idx:words', wordIndex, true);
  await saveIndex(redis, 'idx:categories', categoryIndex, false);
  await saveIndex(redis, 'idx:brands', brandIndex, false);
  await saveDocLengths(redis, docLengths);
  
  console.log(`✅ Indexy: ${wordIndex.size} slov, ${categoryIndex.size} kategórií, ${brandIndex.size} značiek`);
}

async function saveIndex(redis, key, indexMap, isWordIndex) {
  await redis.del(key);
  const pipeline = redis.pipeline();
  
  for (const [term, data] of indexMap) {
    if (isWordIndex) {
      const obj = Object.fromEntries(data);
      pipeline.hset(key, term, JSON.stringify(obj));
    } else {
      pipeline.hset(key, term, JSON.stringify([...data]));
    }
  }
  
  await pipeline.exec();
}

async function saveDocLengths(redis, docLengths) {
  await redis.del('idx:docLengths');
  const pipeline = redis.pipeline();
  
  const entries = [...docLengths.entries()];
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    for (const [id, len] of batch) {
      pipeline.hset('idx:docLengths', id, len);
    }
  }
  
  await pipeline.exec();
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Odstráň diakritiku
    .replace(/[^a-z0-9\s]/g, ' ')    // Len alfanumerické znaky
    .replace(/\s+/g, ' ')
    .trim();
}

// Extrakcia kľúčových slov z produktu
function extractKeywords(product) {
  const keywords = [];
  
  // Z názvu
  if (product.title) {
    const titleWords = normalizeText(product.title).split(/\s+/);
    keywords.push(...titleWords);
  }
  
  // Zo značky
  if (product.brand) {
    keywords.push(normalizeText(product.brand));
  }
  
  // Z kategórií
  if (product.categoryPath) {
    product.categoryPath.forEach(cat => {
      const catWords = normalizeText(cat).split(/\s+/);
      keywords.push(...catWords);
    });
  }
  
  // Z popisu - len prvých 50 slov
  if (product.description) {
    const descWords = normalizeText(product.description).split(/\s+/).slice(0, 50);
    keywords.push(...descWords);
  }
  
  return [...new Set(keywords.filter(w => w.length >= 2))];
}
