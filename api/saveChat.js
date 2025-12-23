/**
 * Vercel API Endpoint: /api/saveChat
 * 
 * Analytický endpoint pre chatbot - ukladá session, produktové odporúčania a kliky.
 * 
 * Tabuľky v Supabase:
 * - chat_sessions: Informácie o session
 * - chat_product_recommendations: Odporúčania produktov
 * - chat_recommended_products: Jednotlivé odporúčané produkty
 * - chat_product_clicks: Kliky na produkty
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

/**
 * Vytvorí user_id hash z IP adresy
 * @param {string} ip - IP adresa
 * @returns {string} - Hash ID pre používateľa
 */
function getUserIdFromIp(ip) {
  if (!ip) return null;
  // Vytvoríme SHA-256 hash z IP + salt pre anonymitu
  const salt = 'ragnetiq-chatbot-2024';
  return crypto.createHash('sha256').update(ip + salt).digest('hex').substring(0, 32);
}

/**
 * Získa IP adresu z requestu
 * @param {Request} req - HTTP request
 * @returns {string|null} - IP adresa
 */
function getIpFromRequest(req) {
  // Vercel/Cloudflare headers
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
}

// Inicializácia Supabase klienta
function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not configured');
  }
  
  return createClient(supabaseUrl, supabaseKey);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = getSupabase();
    const { action } = req.body;

    console.log('📊 [Analytics] Action:', action);

    switch (action) {
      // ═══════════════════════════════════════════════════════════════════
      // SESSION MANAGEMENT
      // ═══════════════════════════════════════════════════════════════════
      
      case 'session_start': {
        const { sessionId, website, geoCity } = req.body;
        
        if (!sessionId || !website) {
          return res.status(400).json({ error: 'sessionId and website required' });
        }

        // Vždy vytvor user_id z IP adresy (deterministický hash)
        const ip = getIpFromRequest(req);
        const finalUserId = getUserIdFromIp(ip);
        
        console.log('📊 [Analytics] IP:', ip, '-> User ID:', finalUserId);

        // Vytvor novú session
        const { data, error } = await supabase
          .from('chat_sessions')
          .insert([{
            id: sessionId,
            user_id: finalUserId,
            website: website,
            started_at: new Date().toISOString(),
            total_messages: 0,
            had_product_recommendation: false,
            had_product_click: false,
            email_submitted: false,
            geo_city: geoCity || null,
            duration_seconds: 0
          }])
          .select();

        if (error) {
          // Session už existuje - to je OK
          if (error.code === '23505') {
            console.log('📊 [Analytics] Session already exists:', sessionId);
            return res.status(200).json({ success: true, exists: true });
          }
          throw error;
        }

        console.log('📊 [Analytics] Session started:', sessionId);
        return res.status(200).json({ success: true, data });
      }

      case 'session_update': {
        const { sessionId, totalMessages, hadProductRecommendation, hadProductClick, emailSubmitted } = req.body;
        
        if (!sessionId) {
          return res.status(400).json({ error: 'sessionId required' });
        }

        const updateData = {};
        if (totalMessages !== undefined) updateData.total_messages = totalMessages;
        if (hadProductRecommendation !== undefined) updateData.had_product_recommendation = hadProductRecommendation;
        if (hadProductClick !== undefined) updateData.had_product_click = hadProductClick;
        if (emailSubmitted !== undefined) updateData.email_submitted = emailSubmitted;

        const { error } = await supabase
          .from('chat_sessions')
          .update(updateData)
          .eq('id', sessionId);

        if (error) throw error;

        console.log('📊 [Analytics] Session updated:', sessionId, updateData);
        return res.status(200).json({ success: true });
      }

      case 'session_end': {
        const { sessionId, durationSeconds } = req.body;
        
        if (!sessionId) {
          return res.status(400).json({ error: 'sessionId required' });
        }

        const updateData = {
          ended_at: new Date().toISOString()
        };
        
        // Ak máme duration z klienta, použijeme ju
        if (durationSeconds !== undefined && durationSeconds !== null) {
          updateData.duration_seconds = Math.round(durationSeconds);
        }

        const { error } = await supabase
          .from('chat_sessions')
          .update(updateData)
          .eq('id', sessionId);

        if (error) throw error;

        console.log('📊 [Analytics] Session ended:', sessionId, 'duration:', durationSeconds, 's');
        return res.status(200).json({ success: true });
      }

      // ═══════════════════════════════════════════════════════════════════
      // PRODUCT RECOMMENDATIONS
      // ═══════════════════════════════════════════════════════════════════

      case 'product_recommendation': {
        const { sessionId, website, messageIndex, queryText, category, products } = req.body;
        
        if (!sessionId || !website || !products || products.length === 0) {
          return res.status(400).json({ error: 'sessionId, website, and products required' });
        }

        // Vždy vytvor user_id z IP adresy (deterministický hash)
        const ip = getIpFromRequest(req);
        const finalUserId = getUserIdFromIp(ip);

        // 1. Vytvor záznam odporúčania
        const { data: recData, error: recError } = await supabase
          .from('chat_product_recommendations')
          .insert([{
            session_id: sessionId,
            user_id: finalUserId,
            chat_log_id: messageIndex || 0,
            website: website,
            query_text: queryText || null,
            category: category || null
          }])
          .select();

        if (recError) throw recError;

        const recommendationId = recData[0].id;

        // 2. Vytvor záznamy pre jednotlivé produkty
        const productRecords = products.map((product, index) => ({
          recommendation_id: recommendationId,
          product_id: String(product.id || product.url || `product_${index}`),
          product_name: product.title || product.name || null,
          product_url: product.url || null,
          position: index + 1,
          price: product.salePrice || product.price || null,
          was_clicked: false
        }));

        const { error: prodError } = await supabase
          .from('chat_recommended_products')
          .insert(productRecords);

        if (prodError) throw prodError;

        // 3. Aktualizuj session - mal produktové odporúčanie
        await supabase
          .from('chat_sessions')
          .update({ had_product_recommendation: true })
          .eq('id', sessionId);

        console.log('📊 [Analytics] Product recommendation saved:', {
          recommendationId,
          productsCount: products.length,
          products: products.map(p => p.title || p.name).slice(0, 3)
        });

        return res.status(200).json({ success: true, recommendationId });
      }

      // ═══════════════════════════════════════════════════════════════════
      // PRODUCT CLICKS
      // ═══════════════════════════════════════════════════════════════════

      case 'product_click': {
        const { sessionId, website, productId, productUrl, position } = req.body;
        
        if (!sessionId || !productId) {
          return res.status(400).json({ error: 'sessionId and productId required' });
        }

        // Vždy vytvor user_id z IP adresy (deterministický hash)
        const ip = getIpFromRequest(req);
        const finalUserId = getUserIdFromIp(ip);

        // 1. Zaznamenaj klik
        const { error: clickError } = await supabase
          .from('chat_product_clicks')
          .insert([{
            session_id: sessionId,
            user_id: finalUserId,
            product_id: String(productId),
            position: position || null,
            website: website || null
          }]);

        if (clickError) throw clickError;

        // 2. Aktualizuj was_clicked v chat_recommended_products
        await supabase
          .from('chat_recommended_products')
          .update({ was_clicked: true })
          .eq('product_id', String(productId));

        // 3. Aktualizuj session - mal klik na produkt
        await supabase
          .from('chat_sessions')
          .update({ had_product_click: true })
          .eq('id', sessionId);

        console.log('📊 [Analytics] Product click recorded:', { sessionId, productId, position });
        return res.status(200).json({ success: true });
      }

      // ═══════════════════════════════════════════════════════════════════
      // EMAIL SUBMITTED
      // ═══════════════════════════════════════════════════════════════════

      case 'email_submitted': {
        const { sessionId } = req.body;
        
        if (!sessionId) {
          return res.status(400).json({ error: 'sessionId required' });
        }

        const { error } = await supabase
          .from('chat_sessions')
          .update({ email_submitted: true })
          .eq('id', sessionId);

        if (error) throw error;

        console.log('📊 [Analytics] Email submitted for session:', sessionId);
        return res.status(200).json({ success: true });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }

  } catch (error) {
    console.error('❌ [Analytics] Error:', error.message);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
