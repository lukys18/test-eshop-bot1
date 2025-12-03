// api/syncProducts.js
// Endpoint pre synchronizáciu produktov zo Shopify - volať raz denne (cron job alebo manuálne)
// Ukladá produkty do Vercel KV alebo ako fallback do globálnej premennej

// Globálna cache pre produkty (fallback ak nemáme KV)
let productsCache = {
  products: [],
  collections: [],
  discounts: [],
  lastSync: null,
  totalProducts: 0
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  const SYNC_SECRET = process.env.SYNC_SECRET || 'test-sync-secret'; // Pre ochranu endpointu

  // GET - vráti uložené produkty (alebo sync ak je cron)
  if (req.method === 'GET') {
    // Vercel Cron jobs posielajú GET s špeciálnym headerom
    const isCronJob = req.headers['x-vercel-cron'] === '1' || req.query?.cron === 'true';
    
    if (isCronJob) {
      // Presmeruj na sync logiku
      return await performSync(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, res);
    }
    
    try {
      // Skús načítať z KV ak je dostupné
      let cachedData = null;
      
      try {
        if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
          const kvResponse = await fetch(`${process.env.KV_REST_API_URL}/get/shopify_products`, {
            headers: {
              Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`
            }
          });
          if (kvResponse.ok) {
            const kvData = await kvResponse.json();
            if (kvData.result) {
              cachedData = JSON.parse(kvData.result);
            }
          }
        }
      } catch (kvError) {
        console.log('KV not available, using memory cache');
      }

      // Fallback na memory cache
      if (!cachedData && productsCache.lastSync) {
        cachedData = productsCache;
      }

      if (cachedData && cachedData.products && cachedData.products.length > 0) {
        return res.status(200).json({
          success: true,
          data: cachedData,
          source: 'cache',
          lastSync: cachedData.lastSync
        });
      }

      // Ak nemáme cache, vráť prázdne dáta s inštrukciou
      return res.status(200).json({
        success: false,
        message: 'No cached products. Please run sync first by calling POST /api/syncProducts',
        data: { products: [], collections: [], discounts: [], lastSync: null }
      });

    } catch (error) {
      console.error('Error fetching cached products:', error);
      return res.status(500).json({ error: 'Failed to fetch cached products', details: error.message });
    }
  }

  // POST - synchronizuj produkty zo Shopify
  if (req.method === 'POST') {
    // Overenie secret tokenu
    const authHeader = req.headers.authorization;
    const providedSecret = authHeader?.replace('Bearer ', '') || req.body?.secret;
    
    // Vercel Cron jobs posielajú špeciálny header
    const isCronJob = req.headers['x-vercel-cron'] === '1' || req.query?.cron === 'true';
    
    if (!isCronJob && providedSecret !== SYNC_SECRET) {
      return res.status(401).json({ error: 'Unauthorized. Provide valid secret.' });
    }

    return await performSync(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Funkcia pre synchronizáciu produktov
async function performSync(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, res) {
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Shopify credentials not configured' });
  }

  try {
    console.log('🔄 Starting Shopify sync...');
    
    // Načítaj VŠETKY produkty (s paginovaním)
    const allProducts = await fetchAllProducts(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN);
    console.log(`📦 Fetched ${allProducts.length} products`);

    // Načítaj kolekcie
    let collections = [];
    try {
      collections = await fetchCollections(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN);
      console.log(`📁 Fetched ${collections.length} collections`);
    } catch (e) {
      console.warn('Could not fetch collections:', e.message);
    }

    // Načítaj zľavy
    let discounts = [];
    try {
      discounts = await fetchDiscounts(SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN);
      console.log(`🏷️ Fetched ${discounts.length} discounts`);
    } catch (e) {
      console.warn('Could not fetch discounts:', e.message);
    }

    const syncData = {
      products: allProducts,
      collections: collections,
      discounts: discounts,
      totalProducts: allProducts.length,
      lastSync: new Date().toISOString()
    };

    // Ulož do KV ak je dostupné
    try {
      if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
        await fetch(`${process.env.KV_REST_API_URL}/set/shopify_products`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(JSON.stringify(syncData))
        });
        console.log('✅ Saved to Vercel KV');
      }
    } catch (kvError) {
      console.log('KV save failed, using memory cache only');
    }

    // Vždy ulož aj do memory cache
    productsCache = syncData;
    console.log('✅ Saved to memory cache');

    return res.status(200).json({
      success: true,
      message: 'Products synced successfully',
      totalProducts: allProducts.length,
      totalCollections: collections.length,
      totalDiscounts: discounts.length,
      syncedAt: syncData.lastSync
    });

  } catch (error) {
    console.error('❌ Sync error:', error);
    return res.status(500).json({ 
      error: 'Failed to sync products',
      details: error.message 
    });
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

// Export cache pre použitie v iných súboroch
export { productsCache };
