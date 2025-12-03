// api/chat.js
// Chat endpoint s RAG systémom pre produkty

// RAG konfigurácia
const STOP_WORDS = new Set([
  'a', 'je', 'to', 'na', 'v', 'sa', 'so', 'pre', 'ako', 'že', 'ma', 'mi', 'me', 'si', 'su', 'som',
  'ale', 'ani', 'az', 'ak', 'bo', 'by', 'co', 'ci', 'do', 'ho', 'im', 'ju', 'ka', 'ku',
  'ne', 'ni', 'no', 'od', 'po', 'pri', 'ta', 'te', 'ti', 'tu', 'ty', 'uz', 'vo', 'za',
  'mate', 'mam', 'chcem', 'potrebujem', 'the', 'and', 'or', 'is', 'are', 'this', 'that'
]);

const SYNONYMS = {
  'cena': ['cenny', 'ceny', 'kolko', 'stoji', 'price', 'eur', 'euro', 'cennik'],
  'produkt': ['tovar', 'vyrobok', 'artikl', 'polozka', 'item', 'produkty', 'sortiment'],
  'dostupny': ['skladom', 'dispozicii', 'sklade', 'available', 'mame', 'dostupnost', 'dostupne'],
  'zlava': ['akcia', 'discount', 'sale', 'zlacnene', 'promo', 'kupon', 'vypredaj'],
  'kupit': ['objednat', 'nakupit', 'buy', 'purchase', 'order', 'kosik'],
  'hladat': ['najst', 'vyhladat', 'search', 'find', 'kde', 'aky', 'ktory', 'odporucit'],
  'velkost': ['size', 'rozmer', 'cislo', 'velkosti', 'sizes'],
  'farba': ['color', 'colour', 'odtien', 'farby', 'farebny'],
  'doprava': ['dorucenie', 'shipping', 'delivery', 'postovne', 'zasielka', 'kurier'],
  'vosk': ['vosok', 'wax', 'ski wax', 'lyze', 'lyziarsky', 'skiing'],
  'lyze': ['lyzovanie', 'skiing', 'ski', 'lyziarsky', 'bezky', 'bezecke']
};

const INTENT_PATTERNS = {
  'count_query': ['kolko', 'pocet', 'celkom', 'vsetky', 'vsetko', 'vsetkych', 'kolko mate'],
  'price_query': ['cena', 'kolko stoji', 'za kolko', 'cennik', 'price'],
  'availability_query': ['skladom', 'dostupny', 'dostupne', 'mame', 'je k dispozicii'],
  'variant_query': ['variant', 'varianty', 'velkost', 'velkosti', 'farba', 'farby', 'druhy', 'typy', 'ake'],
  'discount_query': ['zlava', 'akcia', 'zlacnene', 'vypredaj', 'promo'],
  'recommendation_query': ['odporuc', 'porad', 'navrhni', 'najlepsie', 'top', 'popularny']
};

export default async function handler(req, res) {
  const API_KEY = process.env.API_KEY;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, ragContext = '' } = req.body;

  try {
    let enhancedMessages = [...messages];
    const lastUserMessage = getLastUserMessage(messages);
    
    // RAG: Načítaj a spracuj produkty
    const ragResult = await processWithRAG(lastUserMessage, req.headers.host);
    console.log('🧠 RAG Result:', {
      intent: ragResult.intent,
      matchedProducts: ragResult.products.length,
      topScore: ragResult.products[0]?.score || 0
    });
    
    // Vytvor kontext pre AI
    let productContext = ragResult.context;
    
    // Kombinuj s existujúcim RAG kontextom
    let combinedContext = productContext;
    if (ragContext) {
      combinedContext += `\n\nĎALŠIE INFORMÁCIE:\n${ragContext}`;
    }
    
    // Vlož kontext pred poslednú user správu
    if (combinedContext) {
      let lastUserIndex = -1;
      for (let i = enhancedMessages.length - 1; i >= 0; i--) {
        if (enhancedMessages[i]?.role === 'user') {
          lastUserIndex = i;
          break;
        }
      }

      if (lastUserIndex !== -1) {
        enhancedMessages.splice(lastUserIndex, 0, {
          role: 'system',
          content: `DÔLEŽITÉ - Použi PRESNE tieto informácie o produktoch:\n\n${combinedContext}\n\nPRAVIDLÁ:\n- Uvádzaj IBA ceny z tohto kontextu\n- Pri každom produkte uveď presnú cenu a dostupnosť\n- Ak produkt nie je v zozname, povedz že ho nemáme\n- Nedomýšľaj si ceny ani produkty\n- Pri variantoch uveď ceny jednotlivých variantov`
        });
      }
    }

    console.log(`📤 Sending ${enhancedMessages.length} messages to API`);

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: enhancedMessages,
        temperature: 0.3,
        max_tokens: 1000,
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API responded with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Debug info
    data._debug = {
      intent: ragResult.intent,
      matchedProducts: ragResult.products.length,
      topProducts: ragResult.products.slice(0, 3).map(p => ({ title: p.title, score: p.score })),
      contextLength: combinedContext?.length || 0
    };
    
    res.status(200).json(data);
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}

// Získanie poslednej user správy
function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return messages[i].content;
    }
  }
  return '';
}

// RAG spracovanie
async function processWithRAG(query, host) {
  console.log('🧠 RAG processing query:', query);
  
  try {
    // Načítaj produkty z cache
    const baseUrl = `https://${host}`;
    const response = await fetch(`${baseUrl}/api/syncProducts`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      console.warn('❌ Could not fetch products');
      return { intent: null, products: [], context: '' };
    }

    const result = await response.json();
    if (!result.success || !result.data?.products?.length) {
      return { intent: null, products: [], context: '' };
    }

    const products = result.data.products;
    console.log('✅ Loaded', products.length, 'products for RAG');

    // Detekuj intent
    const intent = detectIntent(query);
    console.log('🎯 Detected intent:', intent);

    // Skoruj produkty
    const scoredProducts = scoreProducts(query, products);
    console.log('📊 Scored products, top 3:', scoredProducts.slice(0, 3).map(p => `${p.title}: ${p.score}`));

    // Vytvor kontext podľa intentu
    const context = buildContext(intent, scoredProducts, products, query);

    return {
      intent,
      products: scoredProducts,
      context
    };
  } catch (error) {
    console.error('RAG Error:', error);
    return { intent: null, products: [], context: '' };
  }
}

// Detekcia intentu
function detectIntent(query) {
  const normalized = normalizeText(query);
  
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    if (patterns.some(p => normalized.includes(p))) {
      return intent;
    }
  }
  return 'general_query';
}

// Skorovanie produktov
function scoreProducts(query, products) {
  const normalized = normalizeText(query);
  const queryWords = extractKeywords(normalized);
  const expandedWords = expandWithSynonyms(queryWords);
  
  console.log('🔍 Query keywords:', queryWords);
  console.log('🔍 Expanded with synonyms:', expandedWords);

  const scored = products.map(product => {
    let score = 0;
    
    // Vytvor prehľadávací text z produktu
    const titleNorm = normalizeText(product.title);
    const descNorm = normalizeText(product.description || '');
    const typeNorm = normalizeText(product.product_type || '');
    const tagsNorm = (product.tags || []).map(t => normalizeText(t));
    const variantsNorm = (product.variants || []).map(v => normalizeText(v.title || ''));

    // Skórovanie
    for (const word of expandedWords) {
      if (word.length < 2) continue;
      
      // Presná zhoda v názve (najvyššie skóre)
      if (titleNorm.includes(word)) {
        score += 10;
      }
      
      // Zhoda v type produktu
      if (typeNorm.includes(word)) {
        score += 7;
      }
      
      // Zhoda v tagoch
      if (tagsNorm.some(t => t.includes(word))) {
        score += 5;
      }
      
      // Zhoda vo variantoch
      if (variantsNorm.some(v => v.includes(word))) {
        score += 6;
      }
      
      // Zhoda v popise
      if (descNorm.includes(word)) {
        score += 3;
      }
    }

    // Bonus za dostupnosť
    if (product.available) {
      score += 2;
    }

    // Bonus za zľavu ak sa pýta na akcie
    if (product.has_discount && normalized.match(/zlava|akcia|sale|promo/)) {
      score += 5;
    }

    return { ...product, score };
  });

  // Zoraď podľa skóre
  return scored.sort((a, b) => b.score - a.score);
}

// Extrakcia kľúčových slov
function extractKeywords(text) {
  return text
    .split(/\s+/)
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}

// Rozšírenie synonymami
function expandWithSynonyms(words) {
  const expanded = new Set(words);
  
  for (const word of words) {
    // Pridaj synonymá pre toto slovo
    for (const [key, synonyms] of Object.entries(SYNONYMS)) {
      if (key === word || synonyms.includes(word)) {
        expanded.add(key);
        synonyms.forEach(s => expanded.add(s));
      }
    }
  }
  
  return Array.from(expanded);
}

// Vytvorenie kontextu pre AI
function buildContext(intent, scoredProducts, allProducts, query) {
  const availableCount = allProducts.filter(p => p.available).length;
  const categories = [...new Set(allProducts.map(p => p.product_type).filter(t => t))];
  
  let context = `📊 E-SHOP ŠTATISTIKY:\n`;
  context += `- Celkom produktov: ${allProducts.length}\n`;
  context += `- Skladom: ${availableCount}\n`;
  context += `- Kategórie: ${categories.join(', ') || 'neuvedené'}\n\n`;

  // Podľa intentu uprav výstup
  if (intent === 'count_query') {
    context += `📦 KOMPLETNÝ ZOZNAM PRODUKTOV:\n`;
    allProducts.forEach((p, i) => {
      context += `${i + 1}. ${p.title} - €${p.price.toFixed(2)} ${p.available ? '✅ skladom' : '❌ vypredané'}\n`;
    });
    return context;
  }

  // Pre ostatné intenty - zobraz relevantné produkty
  const relevantProducts = scoredProducts.filter(p => p.score > 0);
  const productsToShow = relevantProducts.length > 0 ? relevantProducts : scoredProducts.slice(0, 10);

  if (relevantProducts.length > 0) {
    context += `🎯 NÁJDENÉ PRODUKTY (zoradené podľa relevancie):\n\n`;
  } else {
    context += `📦 DOSTUPNÉ PRODUKTY:\n\n`;
  }

  productsToShow.forEach((product, index) => {
    context += `${index + 1}. **${product.title}**`;
    if (product.score > 0) {
      context += ` [skóre: ${product.score}]`;
    }
    context += `\n`;
    
    // Varianty s cenami
    if (product.variants && product.variants.length > 1) {
      context += `   💰 VARIANTY A CENY:\n`;
      product.variants.forEach(v => {
        if (v.title) {
          context += `      • ${v.title}: €${v.price.toFixed(2)}`;
          if (v.compare_at_price > v.price) {
            context += ` (zľava z €${v.compare_at_price.toFixed(2)})`;
          }
          context += v.available ? ` ✅ (${v.inventory_quantity} ks)` : ' ❌ vypredané';
          context += `\n`;
        }
      });
    } else {
      context += `   💰 Cena: €${product.price.toFixed(2)}`;
      if (product.has_discount) {
        context += ` (pôvodne €${product.compare_at_price.toFixed(2)}, zľava ${product.discount_percentage}%)`;
      }
      context += `\n`;
      context += `   📦 Dostupnosť: ${product.available ? `✅ SKLADOM (${product.total_inventory} ks)` : '❌ VYPREDANÉ'}\n`;
    }
    
    if (product.product_type) {
      context += `   📁 Kategória: ${product.product_type}\n`;
    }
    
    if (product.description) {
      const shortDesc = product.description.substring(0, 120);
      context += `   📝 ${shortDesc}${product.description.length > 120 ? '...' : ''}\n`;
    }
    
    context += `\n`;
  });

  return context;
}

// Normalizácia textu
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
