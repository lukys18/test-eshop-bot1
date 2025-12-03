// api/syncProducts.js
// Endpoint pre synchronizáciu produktov zo Shopify
// Používa Upstash Redis ako perzistentnú cache

const CACHE_KEY = 'shopify_products';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hodín

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  // Upstash/KV - podporuje obe pomenovania
  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel Cron job - vynúť refresh
  const isCronJob = req.headers['x-vercel-cron'] === '1';

  try {
    // Ak NIE je cron, skús najprv načítať z cache
    if (!isCronJob && UPSTASH_URL && UPSTASH_TOKEN) {
      const cachedData = await getFromUpstash(UPSTASH_URL, UPSTASH_TOKEN);
      
      if (cachedData && cachedData.products && cachedData.products.length > 0) {
        console.log(`📦 Returning ${cachedData.products.length} products from Upstash cache`);
        return res.status(200).json({
          success: true,
          data: cachedData,
          source: 'upstash-cache',
          lastSync: cachedData.lastSync
        });
      }
    }

    // Cache je prázdna alebo je to cron job - načítaj zo Shopify
    console.log(isCronJob ? '⏰ Cron job - refreshing cache...' : '🔄 Cache empty, fetching from Shopify...');
    
    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Shopify credentials not configured' });
    }

    // Načítaj produkty zo Shopify
    const allProducts = await fetchAllProducts(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN);
    console.log(`📦 Fetched ${allProducts.length} products from Shopify`);

    // Načítaj kolekcie
    let collections = [];
    try {
      collections = await fetchCollections(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN);
      console.log(`📁 Fetched ${collections.length} collections`);
    } catch (e) {
      console.warn('Could not fetch collections:', e.message);
    }

    const syncData = {
      products: allProducts,
      collections: collections,
      totalProducts: allProducts.length,
      lastSync: new Date().toISOString()
    };

    // Ulož do Upstash
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      await saveToUpstash(UPSTASH_URL, UPSTASH_TOKEN, syncData);
      console.log('✅ Saved to Upstash Redis');
    }

    return res.status(200).json({
      success: true,
      data: syncData,
      source: 'shopify-fresh',
      message: `Loaded ${allProducts.length} products`
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ error: 'Failed to fetch products', details: error.message });
  }
}

// Upstash Redis funkcie
async function getFromUpstash(url, token) {
  try {
    const response = await fetch(`${url}/get/${CACHE_KEY}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data.result) {
      return JSON.parse(data.result);
    }
    return null;
  } catch (e) {
    console.warn('Upstash get error:', e.message);
    return null;
  }
}

async function saveToUpstash(url, token, data) {
  const response = await fetch(`${url}/set/${CACHE_KEY}?EX=${CACHE_TTL_SECONDS}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(data))
  });
  
  if (!response.ok) {
    throw new Error(`Upstash save failed: ${response.status}`);
  }
}

// Pomocná funkcia pre Shopify API volania
async function shopifyFetch(storeUrl, accessToken, endpoint) {
  const response = await fetch(`https://${storeUrl}/admin/api/2024-01/${endpoint}`, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// Načítanie VŠETKÝCH produktov s paginovaním
async function fetchAllProducts(storeUrl, accessToken) {
  let allProducts = [];
  let pageInfo = null;
  let hasNextPage = true;
  const limit = 250; // Maximum povolené Shopify API

  while (hasNextPage) {
    let endpoint = `products.json?limit=${limit}&status=active`;
    if (pageInfo) {
      endpoint = `products.json?limit=${limit}&page_info=${pageInfo}`;
    }

    const response = await fetch(`https://${storeUrl}/admin/api/2024-01/${endpoint}`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status}`);
    }

    const data = await response.json();
    const formattedProducts = data.products.map(formatProduct);
    allProducts = allProducts.concat(formattedProducts);

    // Kontrola Link headeru pre paginovanie
    const linkHeader = response.headers.get('Link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/page_info=([^>&]*)/);
      pageInfo = match ? match[1] : null;
      hasNextPage = !!pageInfo;
    } else {
      hasNextPage = false;
    }

    console.log(`  Loaded ${allProducts.length} products so far...`);
  }

  return allProducts;
}

// Načítanie kolekcií
async function fetchCollections(storeUrl, accessToken) {
  const customData = await shopifyFetch(storeUrl, accessToken, 'custom_collections.json?limit=250');
  const smartData = await shopifyFetch(storeUrl, accessToken, 'smart_collections.json?limit=250');
  
  const allCollections = [
    ...customData.custom_collections.map(formatCollection),
    ...smartData.smart_collections.map(formatCollection)
  ];

  return allCollections;
}

// Načítanie zliav
async function fetchDiscounts(storeUrl, accessToken) {
  const data = await shopifyFetch(storeUrl, accessToken, 'price_rules.json');
  return data.price_rules.map(formatPriceRule).filter(rule => rule.active);
}

// Formátovacie funkcie
function formatProduct(product) {
  const mainVariant = product.variants?.[0] || {};
  const price = parseFloat(mainVariant.price || 0);
  const compareAtPrice = parseFloat(mainVariant.compare_at_price || 0);
  const hasDiscount = compareAtPrice > 0 && compareAtPrice > price;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    description: stripHtml(product.body_html || ''),
    product_type: product.product_type || '',
    vendor: product.vendor || '',
    tags: product.tags ? product.tags.split(', ').filter(t => t) : [],
    price: price,
    compare_at_price: compareAtPrice,
    currency: 'EUR',
    has_discount: hasDiscount,
    discount_percentage: hasDiscount ? Math.round((1 - price / compareAtPrice) * 100) : 0,
    available: product.variants?.some(v => 
      v.inventory_management === null || 
      v.inventory_quantity > 0 || 
      v.inventory_policy === 'continue'
    ) || false,
    total_inventory: product.variants?.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0) || 0,
    variants: product.variants?.map(v => ({
      id: v.id,
      title: v.title !== 'Default Title' ? v.title : null,
      sku: v.sku,
      price: parseFloat(v.price || 0),
      compare_at_price: parseFloat(v.compare_at_price || 0),
      available: v.inventory_management === null || v.inventory_quantity > 0 || v.inventory_policy === 'continue',
      inventory_quantity: v.inventory_quantity || 0,
      options: [v.option1, v.option2, v.option3].filter(o => o && o !== 'Default Title')
    })).filter(v => v) || [],
    options: product.options?.filter(o => o.name !== 'Title' || o.values.length > 1).map(o => ({
      name: o.name,
      values: o.values
    })) || [],
    main_image: product.images?.[0]?.src || null,
    url: `/products/${product.handle}`,
    created_at: product.created_at
  };
}

function formatCollection(collection) {
  return {
    id: collection.id,
    title: collection.title,
    handle: collection.handle,
    description: stripHtml(collection.body_html || ''),
    image: collection.image?.src || null
  };
}

function formatPriceRule(rule) {
  const now = new Date();
  const startsAt = new Date(rule.starts_at);
  const endsAt = rule.ends_at ? new Date(rule.ends_at) : null;
  
  return {
    id: rule.id,
    title: rule.title,
    value_type: rule.value_type,
    value: rule.value,
    active: startsAt <= now && (!endsAt || endsAt >= now)
  };
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
