// api/syncXML.js
// Jednoduchá synchronizácia XML produktov do Upstash Redis
// Cron: raz denne

import axios from 'axios';
import xml2js from 'xml2js';
import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const XML_URL = process.env.XML_URL;
  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!XML_URL) return res.status(500).json({ error: 'XML_URL not configured' });
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: 'Upstash Redis not configured' });
  }

  const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

  try {
    const startTime = Date.now();
    console.log('📥 Sťahujem XML...');

    // Stiahni a parsuj XML
    const response = await axios.get(XML_URL, {
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      maxContentLength: 200 * 1024 * 1024,
    });

    const parser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: false,
      mergeAttrs: true
    });

    const xmlData = await parser.parseStringPromise(response.data);
    
    // Extrahuj produkty
    let rawProducts = [];
    if (xmlData.rss?.channel?.item) {
      const items = xmlData.rss.channel.item;
      rawProducts = Array.isArray(items) ? items : [items];
    }

    console.log(`📦 Nájdených ${rawProducts.length} produktov`);

    if (rawProducts.length === 0) {
      return res.status(400).json({ error: 'No products found in XML' });
    }

    // Transformuj produkty
    const products = rawProducts.map(raw => {
      const id = String(raw['g:id'] || `p_${Math.random().toString(36).substr(2, 9)}`);
      const title = decodeHtml(raw['g:title'] || '');
      const description = decodeHtml(raw['g:description'] || '').substring(0, 500);
      
      const priceStr = raw['g:price'] || '0';
      const price = parseFloat(String(priceStr).replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
      
      const salePriceStr = raw['g:sale_price'];
      const salePrice = salePriceStr ? 
        parseFloat(String(salePriceStr).replace(/[^\d.,]/g, '').replace(',', '.')) : null;

      const categoryFull = decodeHtml(raw['g:product_type'] || raw['g:google_product_category'] || '');
      let categoryParts = categoryFull.split('|').map(s => s.trim()).filter(Boolean);
      
      // Preskočiť "Heureka.sk" ako kategóriu
      if (categoryParts[0] === 'Heureka.sk') {
        categoryParts = categoryParts.slice(1);
      }
      
      const brand = decodeHtml(raw['g:brand'] || '');
      const available = String(raw['g:availability'] || '').toLowerCase().includes('in stock');
      
      let image = raw['g:image_link'];
      if (typeof image === 'object' && image !== null) {
        image = image._ || image['#text'] || String(image);
      }
      
      let url = raw['g:link'];
      if (typeof url === 'object' && url !== null) {
        url = url._ || url['#text'] || String(url);
      }

      // Vytvor searchText pre vyhľadávanie (bez diakritiky, lowercase)
      const searchText = normalize(`${title} ${brand} ${description} ${categoryFull}`);

      return {
        id,
        title,
        description,
        price,
        salePrice,
        hasDiscount: salePrice && salePrice < price,
        discountPercent: salePrice && salePrice < price ? Math.round((1 - salePrice / price) * 100) : 0,
        category: categoryFull,
        categoryPath: categoryParts,
        categoryMain: categoryParts[0] || '',
        brand,
        available,
        image: image ? String(image).trim() : null,
        url: url ? String(url).trim() : null,
        searchText
      };
    });

    // Ulož do Redis
    console.log('💾 Ukladám do Redis...');
    
    // Vymaž staré dáta
    await redis.del('products:all');
    await redis.del('products:count');
    await redis.del('products:lastUpdate');
    
    // Ulož všetky produkty ako jeden JSON array
    await redis.set('products:all', JSON.stringify(products));
    await redis.set('products:count', products.length);
    await redis.set('products:lastUpdate', new Date().toISOString());

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Sync hotový za ${duration}s - ${products.length} produktov`);

    return res.status(200).json({
      success: true,
      message: `Synced ${products.length} products`,
      timestamp: new Date().toISOString(),
      duration: `${duration}s`,
      sample: products.slice(0, 2)
    });

  } catch (error) {
    console.error('❌ Sync error:', error);
    return res.status(500).json({ error: 'Sync failed', details: error.message });
  }
}

function decodeHtml(text) {
  if (!text) return '';
  return String(text)
    // Základné HTML entity
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Slovenské znaky
    .replace(/&aacute;/g, 'á')
    .replace(/&Aacute;/g, 'Á')
    .replace(/&eacute;/g, 'é')
    .replace(/&Eacute;/g, 'É')
    .replace(/&iacute;/g, 'í')
    .replace(/&Iacute;/g, 'Í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&Oacute;/g, 'Ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&Uacute;/g, 'Ú')
    .replace(/&yacute;/g, 'ý')
    .replace(/&Yacute;/g, 'Ý')
    .replace(/&scaron;/g, 'š')
    .replace(/&Scaron;/g, 'Š')
    .replace(/&ccaron;/g, 'č')
    .replace(/&Ccaron;/g, 'Č')
    .replace(/&zcaron;/g, 'ž')
    .replace(/&Zcaron;/g, 'Ž')
    .replace(/&ncaron;/g, 'ň')
    .replace(/&rcaron;/g, 'ŕ')
    .replace(/&lcaron;/g, 'ľ')
    .replace(/&tcaron;/g, 'ť')
    .replace(/&dcaron;/g, 'ď')
    .replace(/&ocircumflex;/g, 'ô')
    // Odstráň HTML tagy
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
