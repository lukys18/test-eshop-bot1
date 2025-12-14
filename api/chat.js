// api/chat.js
// Konverzačný AI asistent pre Drogériu Domov
// Optimalizovaný pre poradenstvo a cielené odporúčania

import { searchProducts, getCategories, getBrands, getStats, getDiscountedProducts, searchByCategory, searchByBrand } from '../redisClient.js';

const DEEPSEEK_API_KEY = process.env.API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Pomocná funkcia pre normalizáciu textu (bez diakritiky)
function normalizeForSearch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Systémový prompt pre konverzačného asistenta
const SYSTEM_PROMPT = `Si priateľský asistent online drogérie Drogéria Domov (drogeriadomov.sk).

KRITICKÉ PRAVIDLÁ:
1. Môžeš odporúčať IBA produkty, ktoré sú uvedené v sekcii "NÁJDENÉ PRODUKTY" v kontexte.
2. Ak tam nie sú žiadne produkty, NIKDY si ich nevymýšľaj - namiesto toho sa opýtaj zákazníka na spresnenie.
3. Zdraviť (ahoj, dobrý deň) môžeš LEN na prvú správu v konverzácii. Potom už pozdrav vynechaj.

TVOJE ÚLOHY:
1. Pomáhaj zákazníkom nájsť produkty z ponuky
2. Pýtaj sa doplňujúce otázky ak je požiadavka príliš všeobecná
3. Odporúčaj max 3-5 produktov z kontextu
4. Ak zákazník len poďakuje alebo sa lúči, odpovedz stručne a prívetivo

FORMÁT PRODUKTOV (použi LEN ak máš produkty v kontexte):
**[Názov z kontextu]** - [Cena z kontextu] €
[Popis]
Odkaz: [URL z kontextu - PRESNE ako je uvedený]

AK NEMÁŠ PRODUKTY V KONTEXTE A ZÁKAZNÍK SA PÝTA NA PRODUKT:
- Povedz zákazníkovi, že pre lepšie výsledky potrebuješ viac informácií
- Opýtaj sa na značku, typ produktu, alebo účel použitia
- NEVYMÝŠĽAJ žiadne produkty ani značky

AK ZÁKAZNÍK NEPÝTA NA PRODUKTY (ďakuje, zdraví, všeobecná otázka):
- Odpovedz prirodzene a stručne
- Nepýtaj sa hneď na produkty, ak to nie je relevantné

Odpovedaj VŽDY po slovensky, priateľsky a stručne.`;

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
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🚀 NOVÁ SPRÁVA:', message);
    console.log('📜 História:', history.length, 'správ');
    
    // Analyzuj zámer používateľa
    const intent = analyzeIntent(message);
    console.log(`💬 Správa: "${message}" | Zámer: ${intent.type}`);
    
    // Získaj kontext na základe zámeru
    const context = await buildContext(message, intent);
    
    // Log pre debug
    console.log('📦 Context products:', context.products?.length || 0);
    if (context.products?.length > 0) {
      console.log('📦 Nájdené produkty:');
      context.products.forEach((p, i) => {
        console.log(`   ${i+1}. ${p.title} | ${p.price}€ | ${p.url}`);
      });
    }
    
    // Vytvor správy pre AI
    const messages = buildMessages(message, history, context, intent);
    
    console.log('🤖 Posielam do AI:', messages.length, 'správ');
    
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
        temperature: 0.5,
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
      productsFound: context.products?.length || 0,
      _debug: {
        searchInfo: context.searchInfo,
        hasProducts: context.products?.length > 0
      }
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
  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(w => w.length >= 2);
  
  console.log('🧠 Analyzujem zámer:', { message: lower, wordCount: words.length });
  
  // Čistý pozdrav (len pozdrav, prípadne s krátkym doplnkom)
  if (/^(ahoj|dobrý|čau|zdravím|hey|hi|nazdar|cau|dobry)\s*[!.,]?$/i.test(lower) ||
      /^(ahoj|dobrý|čau|zdravím|hey|hi|nazdar|cau|dobry)\s+(ako sa máš|ako sa máte|čo robíš)?[!.,]?$/i.test(lower)) {
    console.log('👋 Rozpoznaný zámer: pozdrav');
    return { type: 'greeting' };
  }
  
  // Ďakovanie / rozlúčka
  if (/^(ďakujem|dakujem|vďaka|dík|díky|diky|super|ok|okej|fajn|dobre|áno|ano|nie|dovidenia|zbohom|ahoj\s*$)/i.test(lower) && words.length <= 3) {
    console.log('🙏 Rozpoznaný zámer: poďakovanie/rozlúčka');
    return { type: 'thanks' };
  }
  
  // Všeobecná otázka (nie o produktoch)
  if (/^(ako|čo|kto|kde|kedy|prečo)\s+(ste|si|to|je|funguje|robíte)/i.test(lower) && 
      !/produkt|tovar|predávate|máte/i.test(lower)) {
    console.log('❓ Rozpoznaný zámer: všeobecná otázka');
    return { type: 'general_question' };
  }
  
  // Zľavy/akcie
  if (/zlav|akci|výpredaj|lacn|znížen|promo/i.test(lower)) {
    console.log('💰 Rozpoznaný zámer: zľavy');
    return { type: 'discounts' };
  }
  
  // Kategórie
  if (/kategór|sortiment|ponuk|máte|čo predávate/i.test(lower)) {
    console.log('📂 Rozpoznaný zámer: kategórie');
    return { type: 'categories' };
  }
  
  // Značky
  if (/značk|brand|výrobc/i.test(lower)) {
    console.log('🏷️ Rozpoznaný zámer: značky');
    return { type: 'brands' };
  }
  
  // Darček
  if (/darček|darovať|pre .*(mamu|otca|priateľ|manžel|dieťa|babičk)/i.test(lower)) {
    console.log('🎁 Rozpoznaný zámer: darček');
    return { type: 'gift', needsMore: true };
  }
  
  // Produktové kľúčové slová - jasne hľadá produkt
  const productKeywords = [
    'šampón', 'mydlo', 'krém', 'parfém', 'dezodorant', 'zubná', 
    'prací', 'čistiaci', 'kozmetik', 'makeup', 'rúž', 'sprchov',
    'gel', 'pasta', 'pleť', 'vlasy', 'telo', 'ruky', 'tvár',
    'prášok', 'aviváž', 'wc', 'toaletn', 'papier', 'utierky',
    'hľadám', 'potrebujem', 'chcem', 'kúpiť', 'kúpi', 'produkt'
  ];
  
  const hasProductKeyword = productKeywords.some(kw => lower.includes(kw));
  
  if (hasProductKeyword) {
    // Ak je len 1-2 slová, potrebuje spresnenie
    if (words.length <= 2) {
      console.log('📦 Rozpoznaný zámer: všeobecná kategória (potrebuje spresnenie)');
      return { type: 'general_category', needsMore: true };
    }
    console.log('🔍 Rozpoznaný zámer: konkrétne vyhľadávanie produktu');
    return { type: 'specific_search' };
  }
  
  // Ak má dosť slov, skús to ako vyhľadávanie
  if (words.length >= 3) {
    console.log('🔍 Rozpoznaný zámer: vyhľadávanie (viac slov)');
    return { type: 'specific_search' };
  }
  
  // Krátka správa bez produktových kľúčových slov = konverzácia
  console.log('💬 Rozpoznaný zámer: všeobecná konverzácia (bez produktových slov)');
  return { type: 'conversation' };
}

// Vytvorenie kontextu pre AI
async function buildContext(message, intent) {
  const context = {
    products: [],
    categories: [],
    brands: [],
    stats: null,
    searchInfo: null
  };
  
  console.log('🏗️ Budujem kontext pre zámer:', intent.type);
  
  try {
    switch (intent.type) {
      case 'greeting':
        context.stats = await getStats();
        console.log('📊 Stats loaded:', context.stats?.productCount, 'products');
        break;
      
      case 'thanks':
      case 'conversation':
      case 'general_question':
        // Pre tieto zámery NEHĽADÁME produkty - je to len konverzácia
        console.log('💬 Konverzačný zámer - nehľadám produkty');
        context.stats = await getStats(); // Len základné info o obchode
        break;
        
      case 'discounts':
        context.products = await getDiscountedProducts(5);
        console.log('💰 Discounted products:', context.products.length);
        if (context.products.length > 0) {
          console.log('💰 Zľavnené produkty:', context.products.map(p => `${p.title} (-${p.discountPercent}%)`));
        }
        break;
        
      case 'categories':
        context.categories = await getCategories();
        console.log('📂 Categories:', context.categories.length);
        break;
        
      case 'brands':
        context.brands = await getBrands();
        console.log('🏷️ Brands:', context.brands.length);
        break;
        
      case 'general_category':
      case 'specific_search':
      case 'gift':
        // Tieto zámery vyžadujú vyhľadávanie produktov
        console.log('🔍 Spúšťam pokročilé vyhľadávanie pre:', message);
        
        // Extrahuj značku ak je v dotaze
        const brandMatch = message.match(/\b(jar|persil|ariel|nivea|dove|colgate|oral-b|head|pantene|garnier|loreal|palmolive|ajax|domestos|cif|bref|savo|vanish|lenor|fairy)\b/i);
        
        if (brandMatch) {
          console.log('🏷️ Detekovaná značka:', brandMatch[1]);
          const brandProducts = await searchByBrand(brandMatch[1], 5);
          if (brandProducts.length > 0) {
            // Ak je aj ďalší term, filtruj
            const otherTerms = message.toLowerCase().replace(brandMatch[0].toLowerCase(), '').trim();
            if (otherTerms.length > 2) {
              const filtered = brandProducts.filter(p => 
                normalizeForSearch(`${p.title} ${p.description}`).includes(normalizeForSearch(otherTerms))
              );
              if (filtered.length > 0) {
                context.products = filtered;
              } else {
                context.products = brandProducts;
              }
            } else {
              context.products = brandProducts;
            }
            context.searchInfo = { total: context.products.length, matchedTerms: [brandMatch[1]], query: message };
          }
        }
        
        // Ak nemáme produkty zo značky, skús normálne vyhľadávanie
        if (context.products.length === 0) {
          const result = await searchProducts(message, { limit: 5 });
          context.products = result.products;
          context.searchInfo = {
            total: result.total,
            matchedTerms: result.matchedTerms,
            query: result.query
          };
        }
        
        console.log('🔍 Výsledky vyhľadávania:', {
          počet: context.products.length,
          celkom: context.searchInfo?.total || 0,
          matchnutéTermy: context.searchInfo?.matchedTerms || [],
          produkty: context.products.map(p => p.title)
        });
        
        // Ak nenašiel nič, skús vyhľadať po jednotlivých slovách
        if (context.products.length === 0) {
          console.log('⚠️ Žiadne výsledky, skúšam jednotlivé slová...');
          const words = message.split(/\s+/).filter(w => w.length >= 3);
          for (const word of words) {
            console.log(`   Skúšam slovo: "${word}"`);
            const fallback = await searchProducts(word, { limit: 5 });
            if (fallback.products.length > 0) {
              context.products = fallback.products;
              context.searchInfo = { total: fallback.total, matchedTerms: fallback.matchedTerms, query: word };
              console.log(`   ✅ Našiel ${fallback.products.length} produktov pre "${word}"`);
              break;
            }
          }
        }
        
        // Ak stále nič, skús kategóriu
        if (context.products.length === 0) {
          console.log('⚠️ Stále nič, skúšam kategórie...');
          const categoryKeywords = ['šampón', 'mydlo', 'krém', 'prací', 'čistiaci', 'wc', 'riad', 'vlasy', 'telo', 'parfém'];
          for (const kw of categoryKeywords) {
            if (message.toLowerCase().includes(kw) || message.toLowerCase().includes(normalizeForSearch(kw))) {
              const catProducts = await searchByCategory(kw, 5);
              if (catProducts.length > 0) {
                context.products = catProducts;
                context.searchInfo = { total: catProducts.length, matchedTerms: [kw], query: kw };
                console.log(`   ✅ Našiel ${catProducts.length} produktov v kategórii "${kw}"`);
                break;
              }
            }
          }
        }
        break;
        
      default:
        console.log('⚠️ Neznámy zámer, preskakujem vyhľadávanie');
        break;
    }
  } catch (error) {
    console.error('❌ Context build error:', error.message, error.stack);
  }
  
  console.log('📋 Finálny kontext:', {
    produkty: context.products.length,
    kategórie: context.categories.length,
    značky: context.brands.length,
    stats: !!context.stats
  });
  
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
  
  // Pre konverzačné zámery nepotrebujeme upozornenie o chýbajúcich produktoch
  const conversationalIntents = ['greeting', 'thanks', 'conversation', 'general_question'];
  
  // Ak nemáme produkty ani iný kontext, upozorni AI (ale len ak hľadal produkty)
  if (!contextMessage && !conversationalIntents.includes(intent.type)) {
    contextMessage = `UPOZORNENIE: Pre dotaz "${message}" som nenašiel žiadne produkty v databáze.
Povedz zákazníkovi, že si neistý a opýtaj sa na upresnenie požiadavky.
NIKDY nevymýšľaj produkty - povedz že v danej kategórii môžeš vyhľadať, ak upresnia čo hľadajú.`;
  }
  
  // Pre konverzačné zámery daj AI vedieť, že nemá hľadať produkty
  if (conversationalIntents.includes(intent.type) && intent.type !== 'greeting') {
    contextMessage = `Toto je konverzačná správa, nie dotaz na produkty. Odpovedz priateľsky a stručne. Ak zákazník potrebuje pomoc s produktmi, opýtaj sa čo hľadá.`;
  }
  
  if (contextMessage) {
    console.log('📝 Context message length:', contextMessage.length);
    messages.push({
      role: 'system',
      content: `DÔLEŽITÉ - KONTEXT PRE TÚTO ODPOVEĎ:\n${contextMessage}\n\n${intent.needsMore ? 'POZNÁMKA: Zákazník má všeobecnú požiadavku. Opýtaj sa na spresnenie pred odporúčaním produktov.' : 'Odporúč LEN produkty z tohto kontextu!'}`
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
