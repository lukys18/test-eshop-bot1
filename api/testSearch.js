// api/testSearch.js
// Testovací endpoint pre overenie vyhľadávania produktov
// Použitie: GET /api/testSearch?q=jar+na+riad

import { searchProducts, getStats, searchByCategory, searchByBrand, getCategories, getBrands } from '../redisClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { q, type = 'search', limit = 5 } = req.query;
  
  try {
    let result = {};
    
    switch (type) {
      case 'stats':
        // Získaj štatistiky databázy
        result = await getStats();
        result.categories = await getCategories();
        result.brands = await getBrands();
        break;
        
      case 'category':
        // Vyhľadaj v kategórii
        if (!q) {
          return res.status(400).json({ error: 'Parameter q je povinný pre category search' });
        }
        const catProducts = await searchByCategory(q, parseInt(limit));
        result = {
          query: q,
          type: 'category',
          count: catProducts.length,
          products: catProducts.map(p => ({
            id: p.id,
            title: p.title,
            brand: p.brand,
            price: p.price,
            salePrice: p.salePrice,
            category: p.categoryMain,
            url: p.url
          }))
        };
        break;
        
      case 'brand':
        // Vyhľadaj podľa značky
        if (!q) {
          return res.status(400).json({ error: 'Parameter q je povinný pre brand search' });
        }
        const brandProducts = await searchByBrand(q, parseInt(limit));
        result = {
          query: q,
          type: 'brand',
          count: brandProducts.length,
          products: brandProducts.map(p => ({
            id: p.id,
            title: p.title,
            brand: p.brand,
            price: p.price,
            salePrice: p.salePrice,
            category: p.categoryMain,
            url: p.url
          }))
        };
        break;
        
      case 'search':
      default:
        // Plné vyhľadávanie
        if (!q) {
          return res.status(400).json({ 
            error: 'Parameter q je povinný',
            usage: {
              search: '/api/testSearch?q=jar na riad',
              stats: '/api/testSearch?type=stats',
              category: '/api/testSearch?type=category&q=domacnost',
              brand: '/api/testSearch?type=brand&q=jar'
            }
          });
        }
        
        console.log('🧪 Test vyhľadávanie:', q);
        const searchResult = await searchProducts(q, { limit: parseInt(limit) });
        
        result = {
          query: q,
          type: 'search',
          total: searchResult.total,
          matchedTerms: searchResult.matchedTerms,
          count: searchResult.products.length,
          products: searchResult.products.map(p => ({
            id: p.id,
            title: p.title,
            brand: p.brand,
            price: p.price,
            salePrice: p.salePrice,
            discount: p.hasDiscount ? `${p.discountPercent}%` : null,
            category: p.categoryMain,
            categoryFull: p.category,
            description: p.description?.substring(0, 150) + '...',
            score: p._score?.toFixed(3),
            url: p.url
          }))
        };
        break;
    }
    
    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
    
  } catch (error) {
    console.error('❌ Test search error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
