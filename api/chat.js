export default async function handler(req, res) {
  const API_KEY = process.env.API_KEY;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { 
    messages, 
    useRAG = false, 
    ragContext = '', 
    sources = [],
    isProductQuery = false
  } = req.body;

  try {
    let enhancedMessages = [...messages];
    let productContext = '';
    
    // VŽDY načítaj produkty z cache pre každý dotaz
    try {
      const lastUserMessage = getLastUserMessage(messages);
      productContext = await getProductContextFromCache(lastUserMessage, req.headers.host);
      console.log('📦 Product context loaded:', productContext ? 'YES' : 'NO');
    } catch (productError) {
      console.warn('Could not fetch product data:', productError.message);
    }
    
    // Kombinuj RAG kontext s produktovým kontextom
    let combinedContext = '';
    if (productContext) {
      combinedContext += productContext;
    }
    if (ragContext) {
      combinedContext += `\n\nĎALŠIE INFORMÁCIE:\n${ragContext}`;
    }
    
    // Vlož kontext pred poslednú user správu
    if (combinedContext) {
      let lastUserIndex = -1;
      for (let i = enhancedMessages.length - 1; i >= 0; i--) {
        if (enhancedMessages[i] && enhancedMessages[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }

      if (lastUserIndex !== -1) {
        enhancedMessages.splice(lastUserIndex, 0, {
          role: 'system',
          content: `DÔLEŽITÉ - Použi PRESNE tieto informácie o produktoch:\n\n${combinedContext}\n\nPRAVIDLÁ:\n- Uvádzaj IBA ceny z tohto kontextu\n- Pri každom produkte uveď presnú cenu a dostupnosť\n- Ak produkt nie je v zozname, povedz že ho nemáme\n- Nedomýšľaj si ceny ani produkty`
        });
      }
    }

    console.log(`Posielam ${enhancedMessages.length} správ do API (produktový kontext: ${productContext ? 'áno' : 'nie'})`);

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: enhancedMessages,
        temperature: 0.3, // Znížené pre presnejšie odpovede
        max_tokens: 800,
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API responded with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Pridaj debug info do odpovede
    data._debug = {
      productContextLoaded: !!productContext,
      productContextLength: productContext?.length || 0,
      combinedContextLength: combinedContext?.length || 0
    };
    
    res.status(200).json(data);
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ 
      error: "Internal Server Error",
      details: error.message 
    });
  }
}

// Pomocná funkcia pre získanie poslednej user správy
function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return '';
}

// Načítanie produktového kontextu z cache
async function getProductContextFromCache(query, host) {
  console.log('🔍 getProductContextFromCache called with query:', query);
  console.log('🔍 Host:', host);
  
  try {
    // Použij host z requestu (funguje vždy)
    const baseUrl = `https://${host}`;
    
    console.log('🔍 Fetching from:', `${baseUrl}/api/syncProducts`);
    
    const response = await fetch(`${baseUrl}/api/syncProducts`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('🔍 Response status:', response.status);

    if (!response.ok) {
      console.warn('❌ Could not fetch cached products, status:', response.status);
      return '';
    }

    const result = await response.json();
    console.log('🔍 Result success:', result.success);
    console.log('🔍 Result source:', result.source);
    console.log('🔍 Products count:', result.data?.products?.length || 0);
    
    if (!result.success || !result.data?.products?.length) {
      console.warn('❌ No cached products available');
      return '';
    }

    const products = result.data.products;
    console.log('✅ Loaded', products.length, 'products from cache');
    
    const normalizedQuery = normalizeText(query);
    const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
    console.log('🔍 Query words:', queryWords);

    // Vyhľadaj relevantné produkty
    let relevantProducts = [];
    
    if (queryWords.length > 0) {
      relevantProducts = products.filter(product => {
        const searchText = normalizeText(
          `${product.title} ${product.description} ${product.product_type} ${product.vendor} ${(product.tags || []).join(' ')}`
        );
        
        return queryWords.some(word => searchText.includes(word));
      });
    }

    // Ak nemáme výsledky alebo je to všeobecný dotaz, pridaj náhodné dostupné produkty
    if (relevantProducts.length < 5) {
      const availableProducts = products
        .filter(p => p.available && !relevantProducts.some(r => r.id === p.id))
        .slice(0, 10 - relevantProducts.length);
      relevantProducts = [...relevantProducts, ...availableProducts];
    }

    // Maximálne 10 produktov pre kontext
    relevantProducts = relevantProducts.slice(0, 10);

    if (relevantProducts.length === 0) {
      return `PRODUKTY V E-SHOPE:\nMomentálne nemáme produkty zodpovedajúce vášmu hľadaniu. Celkovo máme ${products.length} produktov.`;
    }

    // Formátuj produkty pre AI
    const formattedProducts = relevantProducts.map((product, index) => {
      let info = `${index + 1}. **${product.title}**`;
      info += `\n   CENA: €${product.price.toFixed(2)}`;
      
      if (product.has_discount && product.compare_at_price > 0) {
        info += ` (pôvodne €${product.compare_at_price.toFixed(2)}, zľava ${product.discount_percentage}%)`;
      }
      
      info += `\n   DOSTUPNOSŤ: ${product.available ? '✅ SKLADOM' : '❌ VYPREDANÉ'}`;
      
      if (product.total_inventory > 0) {
        info += ` (${product.total_inventory} ks)`;
      }
      
      if (product.product_type) {
        info += `\n   Kategória: ${product.product_type}`;
      }
      
      if (product.variants && product.variants.length > 1) {
        const variantOptions = product.variants
          .filter(v => v.available && v.title)
          .map(v => v.title)
          .slice(0, 5);
        if (variantOptions.length > 0) {
          info += `\n   Varianty: ${variantOptions.join(', ')}`;
        }
      }

      if (product.description && product.description.length > 0) {
        const shortDesc = product.description.substring(0, 100);
        info += `\n   Popis: ${shortDesc}${product.description.length > 100 ? '...' : ''}`;
      }

      return info;
    }).join('\n\n');

    return `PRODUKTY V E-SHOPE (celkovo ${products.length} produktov, posledná aktualizácia: ${result.data.lastSync || 'neznáma'}):\n\n${formattedProducts}`;

  } catch (error) {
    console.error('Error getting product context:', error);
    return '';
  }
}

// Normalizácia textu pre vyhľadávanie
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
