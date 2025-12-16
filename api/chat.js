// api/chat.js
// Konverzačný AI asistent pre Drogériu Domov
// Optimalizovaný pre poradenstvo a cielené odporúčania

import { searchProducts, getCategories, getCategoriesForPrompt, getBrands, getStats, getDiscountedProducts } from '../redisClient.js';

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

// Vylepšenie dotazu z histórie konverzácie
function enhanceQueryFromHistory(message, history, intent) {
  const lower = message.toLowerCase();
  
  // Ak je to follow-up otázka (obsahuje referenčné slová)
  const followUpPatterns = [
    /^(a |a |máte |mate |iné|ine|ďalšie|dalsie|podobné|podobne|ešte|este|aj |tiež|tiez|čo ešte|co este)/i,
    /^(inú|inu|inú značku|inu znacku|inej značky|inej znacky)/i,
    /^(lacnejšie|lacnejsie|drahšie|drahsie|väčšie|vacsie|menšie|mensie)/i
  ];
  
  const isFollowUp = followUpPatterns.some(pattern => pattern.test(lower)) || 
                     (history.length > 0 && message.split(/\s+/).length <= 5);
  
  if (!isFollowUp || history.length === 0) {
    return message;
  }
  
  console.log('🔄 Detekovaný follow-up dotaz, hľadám kontext v histórii...');
  
  // Extrahuj kľúčové slová z posledných správ
  const productKeywords = [
    'šampón', 'sampon', 'mydlo', 'krém', 'krem', 'parfém', 'parfem', 'dezodorant',
    'prací', 'praci', 'čistič', 'cistic', 'gel', 'pasta', 'pleť', 'plet',
    'vlasy', 'telo', 'ruky', 'tvár', 'tvar', 'prášok', 'prasok', 'aviváž', 'avivaz',
    'wc', 'toaletn', 'papier', 'riad', 'podlaha', 'okno', 'kupel', 'zuby', 'ustna',
    'lupiny', 'lupin', 'mastné', 'mastne', 'suché', 'suche', 'poškodené', 'poskodene'
  ];
  
  const brandKeywords = [
    'jar', 'persil', 'ariel', 'nivea', 'dove', 'colgate', 'head', 'shoulders',
    'pantene', 'garnier', 'loreal', 'palmolive', 'ajax', 'domestos', 'clear'
  ];
  
  let foundKeywords = [];
  
  // Prejdi poslednými správami v histórii (user správy)
  const recentUserMessages = history
    .filter(h => h.role === 'user')
    .slice(-3)
    .map(h => h.content.toLowerCase());
  
  for (const historyMsg of recentUserMessages) {
    for (const kw of [...productKeywords, ...brandKeywords]) {
      if (historyMsg.includes(kw) && !foundKeywords.includes(kw)) {
        foundKeywords.push(kw);
      }
    }
  }
  
  if (foundKeywords.length > 0) {
    // Kombinuj pôvodný dotaz s kontextom z histórie
    const enhanced = `${message} ${foundKeywords.join(' ')}`;
    console.log(`📝 Pridané kľúčové slová z histórie: ${foundKeywords.join(', ')}`);
    return enhanced;
  }
  
  return message;
}

// Systémový prompt pre inteligentného konverzačného asistenta
const SYSTEM_PROMPT_BASE = `Si priateľský a inteligentný asistent online drogérie Drogéria Domov (drogeriadomov.sk).

KRITICKÉ PRAVIDLÁ:
1. Môžeš odporúčať IBA produkty, ktoré sú uvedené v sekcii "NÁJDENÉ PRODUKTY" v kontexte.
2. Ak tam nie sú žiadne produkty, NIKDY si ich nevymýšľaj - namiesto toho sa opýtaj zákazníka na spresnenie.
3. Zdraviť (ahoj, dobrý deň) môžeš LEN na prvú správu v konverzácii. Potom už pozdrav vynechaj.
4. NEPÍŠ URL odkazy - produkty sa zobrazia automaticky ako klikateľné kartičky pod tvojou odpoveďou.
5. ODPORÚČAJ LEN KATEGÓRIE Z POSKYTNUTÉHO ZOZNAMU - nevymýšľaj si vlastné kategórie!

INTELIGENTNÉ ODPORÚČANIE:
1. Analyzuj potreby zákazníka (typ produktu, problém, pohlavie, vek)
2. Ak je požiadavka príliš vágna, OPÝTAJ SA doplňujúce otázky:
   - "Je to pre muža alebo ženu?"
   - "Na aký typ pleti/vlasov?"
   - "Preferujete nejakú značku?"
   - "Je to pre vás alebo ako darček?"
3. Pri odporúčaní vysvetli PREČO daný produkt odporúčaš (napr. "Tento produkt je ideálny pre citlivú pokožku...")
4. Spomeň kľúčové benefity z popisu produktu
5. Ak produkt má zľavu, zdôrazni to!

FORMÁT ODPOVEDE (ak máš produkty v kontexte):
- Stručne povedz čo si našiel a PREČO sú tieto produkty vhodné
- Spomeň názvy produktov, ceny a kľúčové benefity
- NEPÍŠ URL odkazy - produkty sa zobrazia ako obrázky pod tvojou správou automaticky

AK NEMÁŠ PRODUKTY V KONTEXTE A ZÁKAZNÍK SA PÝTA NA PRODUKT:
- Povedz zákazníkovi, že pre lepšie výsledky potrebuješ viac informácií
- Opýtaj sa na značku, typ produktu, alebo účel použitia
- NEVYMÝŠĽAJ žiadne produkty ani značky
- Pri odporúčaní kategórií používaj LEN tie z "DOSTUPNÉ KATEGÓRIE"

CROSS-SELL A UPSELL:
- Po odporúčaní hlavného produktu môžeš navrhnúť doplnkový produkt
- Napr. "K tomuto šampónu by sa hodil aj kondicionér tej istej značky"

KRITICKY DÔLEŽITÉ - OZNAČOVANIE PRODUKTOV:
Na KONIEC každej odpovede kde odporúčaš produkty MUSÍŠ pridať skrytý tag s ID produktov, ktoré si odporučil.
Formát: [PRODUCTS:id1,id2,id3]
Použi PRESNE tie ID produktov, ktoré sú uvedené v sekcii "NÁJDENÉ PRODUKTY".
Ak neodporúčaš žiadne produkty, nepridávaj tento tag.
Príklad: Ak odporúčaš produkty s ID "prod123" a "prod456", na koniec odpovede pridaj: [PRODUCTS:prod123,prod456]

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
    
    // Pre konverzačné zámery NEPOUŽÍVAME enhanceQueryFromHistory
    // (nechceme aby sa zobrazili produkty z cache)
    const conversationalIntents = ['greeting', 'thanks', 'conversation', 'general_question'];
    let enhancedMessage = message;
    
    if (!conversationalIntents.includes(intent.type)) {
      // Vytvor rozšírený dotaz z histórie pre follow-up otázky
      enhancedMessage = enhanceQueryFromHistory(message, history, intent);
      console.log(`🔄 Enhanced query: "${enhancedMessage}"`);
    } else {
      console.log(`💬 Konverzačný zámer - preskakujem enhanceQueryFromHistory`);
    }
    
    // Získaj kontext na základe zámeru
    const context = await buildContext(enhancedMessage, intent);
    
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
    let reply = data.choices[0]?.message?.content || 'Prepáčte, nastala chyba.';

    console.log('🤖 AI raw response:', reply.substring(0, 200) + '...');

    // Extrahuj [PRODUCTS:...] tag z odpovede
    const productsTagMatch = reply.match(/\[PRODUCTS?:([^\]]+)\]/i);
    let requestedProductIds = [];
    
    if (productsTagMatch) {
      console.log('🏷️ Nájdený PRODUCTS tag:', productsTagMatch[0]);
      
      // Odstráň tag z odpovede (užívateľ ho nevidí)
      reply = reply.replace(/\[PRODUCTS?:[^\]]+\]/gi, '').trim();
      
      // Parsuj ID produktov - odstráň prípadné "ID:" prefixy
      requestedProductIds = productsTagMatch[1]
        .split(',')
        .map(id => id.trim().replace(/^ID:/i, '').trim())
        .filter(id => id.length > 0);
      
      console.log('🏷️ Parsované ID produktov:', requestedProductIds);
      console.log('🏷️ Dostupné produkty v kontexte:', context.products?.map(p => p.id) || []);
    } else {
      console.log('⚠️ Žiadny PRODUCTS tag v odpovedi');
    }

    // Detekuj či AI hovorí že produkty nie sú relevantné alebo ich nemá
    const replyLower = reply.toLowerCase();
    const aiSaysNoProducts = /nemám v ponuke|nenašl|nenasiel|nemáme|nema\s*v\s*ponuke|momentálne nemám|žiadne produkty|ziadne produkty|nie sú relevantné|nie su relevantne|neodporúčam tieto|neodporucam tieto|bohužiaľ.*nemáme|bohuział.*nemame/.test(replyLower);
    
    // Priprav produkty pre frontend (klikateľné kartičky)
    let productsForDisplay = [];
    
    if (context.products?.length > 0 && !aiSaysNoProducts) {
      
      // METÓDA 1: Ak AI označila produkty tagom [PRODUCTS:...]
      if (requestedProductIds.length > 0) {
        console.log('🎯 Používam produkty z [PRODUCTS] tagu');
        
        // Filtruj produkty podľa ID
        const taggedProducts = context.products.filter(p => 
          requestedProductIds.includes(p.id) || 
          requestedProductIds.includes(String(p.id))
        );
        
        if (taggedProducts.length > 0) {
          productsForDisplay = taggedProducts.map(p => ({
            id: p.id,
            title: p.title,
            price: p.price,
            salePrice: p.salePrice,
            hasDiscount: p.hasDiscount,
            discountPercent: p.discountPercent,
            image: p.image,
            url: p.url,
            brand: p.brand
          }));
          console.log(`   ✅ Nájdených ${taggedProducts.length} produktov z tagu`);
        } else {
          console.log('   ⚠️ Žiadne produkty nenájdené podľa ID z tagu, skúšam fallback');
        }
      }
      
      // METÓDA 2: Fallback - hľadaj produkty spomenuté v texte
      if (productsForDisplay.length === 0) {
        console.log('🔍 Fallback: Hľadám produkty spomenuté v texte odpovede');
        
        const replyNormalized = normalizeForSearch(reply);
        
        const mentionedProducts = context.products.filter(p => {
          const titleNormalized = normalizeForSearch(p.title);
          const brandNormalized = normalizeForSearch(p.brand || '');
          
          // Celý názov
          if (replyNormalized.includes(titleNormalized)) {
            return true;
          }
          
          // Značka + typ produktu
          if (brandNormalized.length > 2 && replyNormalized.includes(brandNormalized)) {
            // Overiť že sa hovorí o rovnakom type produktu
            const titleWords = titleNormalized.split(/\s+/).filter(w => w.length > 3);
            const matchCount = titleWords.filter(w => replyNormalized.includes(w)).length;
            if (matchCount >= 2) {
              return true;
            }
          }
          
          // Prvé slová z názvu
          const titleWords = titleNormalized.split(/\s+/).filter(w => w.length > 2);
          if (titleWords.length >= 3) {
            const partialTitle = titleWords.slice(0, 3).join(' ');
            if (partialTitle.length >= 10 && replyNormalized.includes(partialTitle)) {
              return true;
            }
          }
          
          return false;
        });
        
        console.log(`   Nájdených ${mentionedProducts.length} produktov v texte`);
        
        if (mentionedProducts.length > 0) {
          productsForDisplay = mentionedProducts.slice(0, 5).map(p => ({
            id: p.id,
            title: p.title,
            price: p.price,
            salePrice: p.salePrice,
            hasDiscount: p.hasDiscount,
            discountPercent: p.discountPercent,
            image: p.image,
            url: p.url,
            brand: p.brand
          }));
        }
      }
      
      // METÓDA 3: Ak stále nič a AI hovorí pozitívne, zobraz top produkty
      if (productsForDisplay.length === 0) {
        const aiSaysPositive = /našl|odporúčam|ponúkam|mám pre vás|vyskúšajte|odporucam|ponukam|áno.*máme|ano.*mame/i.test(replyLower);
        if (aiSaysPositive) {
          console.log('   AI odpovedala pozitívne - zobrazujem top 3 produkty');
          productsForDisplay = context.products.slice(0, 3).map(p => ({
            id: p.id,
            title: p.title,
            price: p.price,
            salePrice: p.salePrice,
            hasDiscount: p.hasDiscount,
            discountPercent: p.discountPercent,
            image: p.image,
            url: p.url,
            brand: p.brand
          }));
        } else {
          console.log('   AI neodporučila produkty - nezobrazujem kartičky');
        }
      }
    }
    
    if (aiSaysNoProducts) {
      console.log('🚫 AI hovorí že produkty nie sú relevantné - nezobrazujem kartičky');
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('📤 FINAL RESPONSE TO FRONTEND:');
    console.log('   📝 reply length:', reply.length);
    console.log('   📦 productsForDisplay count:', productsForDisplay.length);
    if (productsForDisplay.length > 0) {
      console.log('   📦 Products being sent:');
      productsForDisplay.forEach((p, i) => {
        console.log(`      ${i+1}. ${p.title} | price: ${p.price} | salePrice: ${p.salePrice} | hasDiscount: ${p.hasDiscount}`);
      });
    }
    console.log('   🎯 intent:', intent.type);
    console.log('   🔍 productsFound:', context.products?.length || 0);
    console.log('═══════════════════════════════════════════════════════════');

    return res.status(200).json({
      reply: reply,
      products: productsForDisplay, // Produkty LEN ak sú relevantné
      intent: intent.type,
      productsFound: context.products?.length || 0,
      _debug: {
        searchInfo: context.searchInfo,
        hasProducts: context.products?.length > 0,
        aiSaysNoProducts: aiSaysNoProducts
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
  const normalized = normalizeForSearch(message);
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
  
  // Konverzačné otázky o pomoci (bez konkrétneho produktu)
  // Vrátane variantov bez diakritiky
  if (/v\s*c(o|ô)m.*(porad|pomoz|pomôž)/i.test(lower) ||
      /c(o|ô).*(porad|pomoz|pomôž)/i.test(lower) ||
      /s\s*c(i|í)m.*(pomoz|pomôž)/i.test(lower) ||
      /(pomoz|pomôž).*mi/i.test(lower) ||
      /(porad|poraď).*mi/i.test(lower) ||
      /co.*(este|ešte).*(vie|vies|vieš)/i.test(lower) ||
      /v\s*com.*este.*vie/i.test(lower) ||
      /ake.*mate.*produkt/i.test(lower) ||
      /co.*vsetko.*mate/i.test(lower) ||
      /co.*dalsie|co.*ďalšie/i.test(lower) ||
      /co.*ponuka|čo.*ponúka/i.test(lower)) {
    console.log('💬 Rozpoznaný zámer: konverzačná otázka o pomoci');
    return { type: 'conversation' };
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
  
  // ŠIROKÉ KATEGÓRIE - potrebujú spresnenie (1-2 slová, všeobecný pojem)
  const broadCategories = [
    'upratovanie', 'upratovat', 'cistenie', 'cistit', 'cistic',
    'kozmetika', 'kozmetiku', 'krasa', 'makeup',
    'pranie', 'prat', 'oblecenie',
    'hygiena', 'hygienicke', 'osobna',
    'domacnost', 'dom', 'byt',
    'kuchyna', 'kuchynske',
    'kupelna', 'kupelne',
    'vlasy', 'vlasova', 'vlasove',
    'telo', 'telova', 'telove',
    'zuby', 'ustna', 'ustnu',
    'vona', 'vone', 'parfem', 'vonavky',
    'deti', 'detske', 'dieta',
    'zvierata', 'pes', 'macka'
  ];
  
  const isBroadCategory = broadCategories.some(cat => 
    normalized === cat || 
    (words.length <= 2 && normalized.includes(cat))
  );
  
  if (isBroadCategory && words.length <= 2) {
    console.log('📦 Rozpoznaný zámer: široká kategória - potrebuje spresnenie');
    return { type: 'broad_category', needsMore: true, category: lower };
  }
  
  // Produktové kľúčové slová - jasne hľadá konkrétny produkt
  const productKeywords = [
    'šampón', 'mydlo', 'krém', 'parfém', 'dezodorant', 'zubná', 
    'prací', 'čistiaci', 'makeup', 'rúž', 'sprchov',
    'gel', 'pasta', 'pleť', 'ruky', 'tvár',
    'prášok', 'aviváž', 'wc', 'toaletn', 'papier', 'utierky',
    'hľadám', 'potrebujem', 'chcem', 'kúpiť', 'kúpi', 'produkt',
    'jar', 'persil', 'ariel', 'nivea', 'dove', 'colgate' // značky
  ];
  
  const hasProductKeyword = productKeywords.some(kw => lower.includes(kw) || normalized.includes(normalizeForSearch(kw)));
  
  if (hasProductKeyword) {
    // Ak je len 1 slovo a nie je to značka, potrebuje spresnenie
    if (words.length === 1 && !['jar', 'persil', 'ariel', 'nivea', 'dove', 'colgate'].some(b => lower.includes(b))) {
      console.log('📦 Rozpoznaný zámer: všeobecná kategória (potrebuje spresnenie)');
      return { type: 'general_category', needsMore: true };
    }
    console.log('🔍 Rozpoznaný zámer: konkrétne vyhľadávanie produktu');
    return { type: 'specific_search' };
  }
  
  // Ak má dosť slov (3+), skús to ako vyhľadávanie
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
    searchInfo: null,
    categoriesPrompt: null,  // Pre dynamický system prompt
    analysis: null,          // Analýza požiadavky
    needsClarification: false,
    clarificationQuestion: null
  };
  
  console.log('🏗️ Budujem kontext pre zámer:', intent.type);
  
  // Vždy načítaj kategórie pre system prompt (AI potrebuje vedieť čo eshop ponúka)
  try {
    context.categoriesPrompt = await getCategoriesForPrompt();
    console.log('📂 Kategórie načítané pre prompt');
  } catch (e) {
    console.log('⚠️ Nepodarilo sa načítať kategórie:', e.message);
  }
  
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
        context.stats = await getStats();
        break;
      
      case 'broad_category':
      case 'general_category':
        // Široká kategória - NEHĽADÁME produkty, ale dáme info o kategóriách
        console.log('📦 Široká kategória - čakám na spresnenie');
        context.stats = await getStats();
        context.categories = await getCategories();
        // Nepridávame produkty - nech sa AI opýta
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
        
      case 'specific_search':
      case 'gift':
        // Vyhľadávanie produktov - len pre konkrétne dotazy
        console.log('🔍 Vyhľadávam produkty pre:', message);
        
        const result = await searchProducts(message, { limit: 5 });
        context.products = result.products;
        context.searchInfo = {
          total: result.total,
          terms: result.terms,
          query: result.query
        };
        context.analysis = result.analysis;
        context.needsClarification = result.needsClarification;
        context.clarificationQuestion = result.clarificationQuestion;
        
        console.log('🔍 Výsledky:', {
          počet: context.products.length,
          celkom: context.searchInfo?.total || 0,
          produkty: context.products.map(p => `${p.title} (skóre: ${p._score})`),
          needsClarification: context.needsClarification
        });
        
        // Ak potrebujeme spresnenie ale máme nejaké výsledky, aj tak ich ukážeme
        if (context.needsClarification && context.products.length > 0) {
          console.log('💡 Máme výsledky ale môžeme spresniť - ukážeme produkty + otázku');
          context.needsClarification = false; // Ukážeme produkty
        }
        
        // Ak nenašiel nič, skús jednotlivé slová
        if (context.products.length === 0) {
          console.log('⚠️ Žiadne výsledky, skúšam jednotlivé slová...');
          const words = message.split(/\s+/).filter(w => w.length >= 3);
          for (const word of words) {
            const fallback = await searchProducts(word, { limit: 5 });
            if (fallback.products.length > 0) {
              context.products = fallback.products;
              context.searchInfo = { total: fallback.total, terms: fallback.terms, query: word };
              context.analysis = fallback.analysis;
              console.log(`✅ Našiel ${fallback.products.length} produktov pre "${word}"`);
              break;
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
    stats: !!context.stats,
    analysis: context.analysis ? 'áno' : 'nie',
    needsClarification: context.needsClarification
  });
  
  return context;
}

// Vytvorenie správ pre AI
function buildMessages(message, history, context, intent) {
  // Vytvor dynamický system prompt s kategóriami
  let systemPrompt = SYSTEM_PROMPT_BASE;
  
  // Pridaj kategórie do system promptu ak sú dostupné
  if (context.categoriesPrompt) {
    systemPrompt += `\n\n${context.categoriesPrompt}`;
  }
  
  const messages = [
    { role: 'system', content: systemPrompt }
  ];
  
  // Pridaj kontext
  let contextMessage = '';
  
  if (context.stats) {
    contextMessage = `INFORMÁCIE O OBCHODE:
- Počet produktov: ${context.stats.productCount}
- Hlavné kategórie: ${context.stats.topCategories.map(c => c.name).join(', ')}
- Top značky: ${context.stats.topBrands.map(b => b.name).join(', ')}`;
  }
  
  // Ak máme analýzu požiadavky, pridaj ju do kontextu
  if (context.analysis) {
    const a = context.analysis;
    let analysisInfo = `\nANALÝZA POŽIADAVKY ZÁKAZNÍKA:`;
    
    if (a.productType) {
      analysisInfo += `\n- Hľadaný typ produktu: ${a.productType}`;
    }
    if (a.targetGender) {
      analysisInfo += `\n- Pohlavie: ${a.targetGender === 'female' ? 'žena' : a.targetGender === 'male' ? 'muž' : 'deti'}`;
    }
    if (a.targetAgeGroup) {
      analysisInfo += `\n- Veková skupina: ${a.targetAgeGroup === 'kids' ? 'deti' : a.targetAgeGroup === 'senior' ? 'seniori' : 'dospelí'}`;
    }
    if (a.problems.length > 0) {
      analysisInfo += `\n- Identifikované problémy: ${a.problems.join(', ')}`;
    }
    if (a.preferredBrand) {
      analysisInfo += `\n- Preferovaná značka: ${a.preferredBrand}`;
    }
    if (a.preferences.length > 0) {
      analysisInfo += `\n- Preferencie: ${a.preferences.join(', ')}`;
    }
    if (a.wantsDiscount) {
      analysisInfo += `\n- Zákazník hľadá zľavy/akcie`;
    }
    
    contextMessage += analysisInfo;
  }
  
  if (context.products && context.products.length > 0) {
    // Vytvor zoznam ID pre jednoduchší tag
    const productIdList = context.products.map(p => p.id).join(', ');
    
    contextMessage += `\n\nPÔVODNÁ POŽIADAVKA ZÁKAZNÍKA: "${message}"

NÁJDENÉ PRODUKTY (${context.products.length} z ${context.searchInfo?.total || '?'}):
Dostupné ID produktov: ${productIdList}

${context.products.map((p, i) => {
  let productInfo = `PRODUKT ${i + 1}:
   ID: ${p.id}
   Názov: ${p.title}
   Značka: ${p.brand || 'neuvedená'}
   Kategória: ${p.category || p.categoryMain}
   Cena: ${p.salePrice ? `${p.price}€ → ${p.salePrice}€ (ZĽAVA -${p.discountPercent}%)` : `${p.price}€`}`;
   
  if (p.description) {
    productInfo += `\n   Popis: ${p.description.substring(0, 150)}...`;
  }
  
  return productInfo;
}).join('\n\n')}

DÔLEŽITÉ INŠTRUKCIE:
- Odporuč LEN produkty z tohto zoznamu
- Pri odporúčaní zdôrazni PREČO je daný produkt vhodný
- Ak má produkt zľavu, zdôrazni to!
- NA KONCI odpovede MUSÍŠ pridať tag s ID produktov ktoré odporúčaš vo formáte:
  [PRODUCTS:1594,1595,1596]
  Použi presne tie čísla ID ktoré sú uvedené vyššie!`;
  }
  
  if (context.categories && context.categories.length > 0 && !context.products.length) {
    contextMessage += `\n\nKATEGÓRIE V OBCHODE:
${context.categories.slice(0, 10).map(c => `- ${c.name} (${c.count} produktov)`).join('\n')}`;
  }
  
  if (context.brands && context.brands.length > 0) {
    contextMessage += `\n\nZNAČKY V OBCHODE:
${context.brands.slice(0, 15).map(b => `- ${b.name} (${b.count} produktov)`).join('\n')}`;
  }
  
  // Pre konverzačné zámery nepotrebujeme upozornenie o chýbajúcich produktoch
  const conversationalIntents = ['greeting', 'thanks', 'conversation', 'general_question'];
  
  // Pri širokej kategórii - inštruuj AI aby sa opýtala
  if (intent.type === 'broad_category' || intent.type === 'general_category') {
    contextMessage += `\n\nPOZNÁMKA: Zákazník použil široký pojem "${message}". 
NEODPORÚČAJ produkty! Namiesto toho sa HO OPÝTAJ na konkrétnejšiu požiadavku.
Príklady otázok:
- Na čo konkrétne to potrebujete? (napr. podlaha, okná, WC, kuchyňa...)
- Hľadáte niečo na konkrétny účel alebo od nejakej značky?
- Aký typ produktu by vás zaujímal?
- Je to pre muža alebo ženu?`;
  }
  
  // Ak potrebujeme spresnenie
  if (context.needsClarification && context.clarificationQuestion) {
    contextMessage += `\n\nDÔLEŽITÉ: Pre lepšie výsledky sa opýtaj zákazníka: "${context.clarificationQuestion}"`;
  }
  
  // Ak nemáme produkty ani iný kontext, upozorni AI (ale len ak hľadal produkty)
  if (!context.products?.length && !conversationalIntents.includes(intent.type) && intent.type !== 'broad_category' && intent.type !== 'general_category') {
    contextMessage += `\n\nUPOZORNENIE: Pre dotaz "${message}" som nenašiel žiadne produkty v databáze.
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
