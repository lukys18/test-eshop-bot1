// api/chat.js
// Konverzačný AI asistent pre Drogériu Domov
// Optimalizovaný pre poradenstvo a cielené odporúčania

import { searchProducts, getCategories, getBrands, getStats, getDiscountedProducts } from '../redisClient.js';

const DEEPSEEK_API_KEY = process.env.API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Systémový prompt pre konverzačného asistenta
const SYSTEM_PROMPT = `Si priateľský a profesionálny asistent online drogérie Drogéria Domov (drogeriadomov.sk).

TVOJE HLAVNÉ CIELE:
1. PORADENSTVO - Pomáhaj zákazníkom nájsť presne to, čo potrebujú
2. DIALÓG - Pýtaj sa doplňujúce otázky pre lepšie pochopenie potrieb
3. ODPORÚČANIA - Odporúčaj konkrétne produkty (max 3-5), nie celé zoznamy

PRAVIDLÁ KOMUNIKÁCIE:
- Keď zákazník povie len všeobecnú kategóriu (napr. "šampón"), OPÝTAJ SA:
  * Na aký typ vlasov? (suché, mastné, normálne, farbené)
  * Máte obľúbenú značku?
  * Preferujete niečo konkrétne? (proti lupinám, pre objem, atď.)
  
- Keď zákazník hľadá darček, OPÝTAJ SA:
  * Pre koho je darček? (muž/žena/dieťa)
  * Aký máte rozpočet?
  * Preferujete kozmetiku, parfumy, alebo praktické veci?

- Pri konkrétnych požiadavkách PONÚKNI 3-5 najlepších možností

FORMÁT PRODUKTOV:
Keď odporúčaš produkt, použi tento formát:
**[Názov produktu]** - [Cena] €
[Krátky popis prečo je vhodný]
[Odkaz na produkt]

DÔLEŽITÉ:
- Odpovedaj VŽDY po slovensky
- Buď stručný ale priateľský
- Ak nemáš presné info, radšej sa opýtaj
- Nikdy nevymýšľaj produkty - používaj len tie z kontextu
- Ak nie sú v kontexte relevantné produkty, povedz to a navrhni alternatívy`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history = [] } = req.body;
  
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DeepSeek API not configured' });
  }

  try {
    // Analyzuj zámer používateľa
    const intent = analyzeIntent(message);
    console.log(`💬 Správa: "${message}" | Zámer: ${intent.type}`);
    
    // Získaj kontext na základe zámeru
    const context = await buildContext(message, intent);
    
    // Vytvor správy pre AI
    const messages = buildMessages(message, history, context, intent);
    
    // Zavolaj DeepSeek API
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('DeepSeek error:', error);
      throw new Error('AI service error');
    }

    const data = await response.json();
    const reply = data.choices[0]?.message?.content || 'Prepáčte, nastala chyba.';

    return res.status(200).json({
      reply: reply,
      intent: intent.type,
      productsFound: context.products?.length || 0
    });

  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({ 
      error: 'Nastala chyba pri spracovaní',
      reply: 'Prepáčte, momentálne mám technické problémy. Skúste to prosím znovu.'
    });
  }
}

// Analýza zámeru používateľa
function analyzeIntent(message) {
  const lower = message.toLowerCase();
  
  // Pozdrav
  if (/^(ahoj|dobrý|čau|zdravím|hey|hi|nazdar)/i.test(lower)) {
    return { type: 'greeting' };
  }
  
  // Zľavy/akcie
  if (/zlav|akci|výpredaj|lacn|znížen|promo/i.test(lower)) {
    return { type: 'discounts' };
  }
  
  // Kategórie
  if (/kategór|sortiment|ponuk|máte|čo predávate/i.test(lower)) {
    return { type: 'categories' };
  }
  
  // Značky
  if (/značk|brand|výrobc/i.test(lower)) {
    return { type: 'brands' };
  }
  
  // Darček
  if (/darček|darovať|pre .*(mamu|otca|priateľ|manžel|dieťa|babičk)/i.test(lower)) {
    return { type: 'gift', needsMore: true };
  }
  
  // Všeobecné kategórie - potrebujú spresnenie
  const generalCategories = [
    'šampón', 'mydlo', 'krém', 'parfém', 'dezodorant', 'zubná', 
    'prací', 'čistiaci', 'kozmetik', 'makeup', 'rúž'
  ];
  
  for (const cat of generalCategories) {
    if (lower.includes(cat) && lower.split(' ').length < 5) {
      return { type: 'general_category', category: cat, needsMore: true };
    }
  }
  
  // Konkrétne vyhľadávanie
  if (lower.split(' ').length >= 2) {
    return { type: 'specific_search' };
  }
  
  return { type: 'general' };
}

// Vytvorenie kontextu pre AI
async function buildContext(message, intent) {
  const context = {
    products: [],
    categories: [],
    brands: [],
    stats: null
  };
  
  try {
    switch (intent.type) {
      case 'greeting':
        context.stats = await getStats();
        break;
        
      case 'discounts':
        context.products = await getDiscountedProducts(5);
        break;
        
      case 'categories':
        context.categories = await getCategories();
        break;
        
      case 'brands':
        context.brands = await getBrands();
        break;
        
      case 'general_category':
      case 'specific_search':
      case 'general':
      default:
        const result = await searchProducts(message, { limit: 5 });
        context.products = result.products;
        context.searchInfo = {
          total: result.total,
          matchedTerms: result.matchedTerms
        };
        break;
    }
  } catch (error) {
    console.error('Context build error:', error);
  }
  
  return context;
}

// Vytvorenie správ pre AI
function buildMessages(message, history, context, intent) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];
  
  // Pridaj kontext
  let contextMessage = '';
  
  if (context.stats) {
    contextMessage = `INFORMÁCIE O OBCHODE:
- Počet produktov: ${context.stats.productCount}
- Hlavné kategórie: ${context.stats.topCategories.map(c => c.name).join(', ')}
- Top značky: ${context.stats.topBrands.map(b => b.name).join(', ')}`;
  }
  
  if (context.products && context.products.length > 0) {
    contextMessage = `NÁJDENÉ PRODUKTY (${context.products.length} z ${context.searchInfo?.total || '?'}):

${context.products.map((p, i) => `${i + 1}. **${p.title}**
   Značka: ${p.brand || 'neuvedená'}
   Kategória: ${p.categoryMain}
   Cena: ${p.salePrice ? `~~${p.price}€~~ **${p.salePrice}€** (-${p.discountPercent}%)` : `${p.price}€`}
   ${p.description ? `Popis: ${p.description.substring(0, 100)}...` : ''}
   URL: ${p.url}`).join('\n\n')}`;
  }
  
  if (context.categories && context.categories.length > 0) {
    contextMessage = `KATEGÓRIE V OBCHODE:
${context.categories.slice(0, 10).map(c => `- ${c.name} (${c.count} produktov)`).join('\n')}`;
  }
  
  if (context.brands && context.brands.length > 0) {
    contextMessage = `ZNAČKY V OBCHODE:
${context.brands.slice(0, 15).map(b => `- ${b.name} (${b.count} produktov)`).join('\n')}`;
  }
  
  if (contextMessage) {
    messages.push({
      role: 'system',
      content: `KONTEXT PRE TÚTO ODPOVEĎ:\n${contextMessage}\n\n${intent.needsMore ? 'POZNÁMKA: Zákazník má všeobecnú požiadavku. Opýtaj sa na spresnenie pred odporúčaním produktov.' : ''}`
    });
  }
  
  // Pridaj históriu (max posledných 6 správ)
  const recentHistory = history.slice(-6);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    });
  }
  
  // Pridaj aktuálnu správu
  messages.push({ role: 'user', content: message });
  
  return messages;
}
