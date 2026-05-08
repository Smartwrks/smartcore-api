import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

/**
 * GET /api/business/customers?search=...
 * Look up customers by name, code, or email. Returns top 10 matches.
 */
router.get('/customers', async (req, res) => {
  try {
    const { search } = req.query;
    let query = supabase
      .from('sc_customers')
      .select('*')
      .eq('account_id', req.account.id)
      .eq('is_active', true)
      .order('customer_name')
      .limit(10);

    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,customer_code.ilike.%${search}%,email.ilike.%${search}%,contact_name.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ customers: data || [] });
  } catch (err) {
    console.error('[business/customers] error:', err);
    res.status(500).json({ error: 'Failed to look up customers' });
  }
});

/**
 * GET /api/business/products?search=...&category=...
 * Search products with pricing and margin info.
 */
router.get('/products', async (req, res) => {
  try {
    const { search, category } = req.query;
    let query = supabase
      .from('sc_products')
      .select('*')
      .eq('account_id', req.account.id)
      .eq('is_active', true)
      .order('product_name')
      .limit(20);

    if (search) {
      query = query.or(
        `product_name.ilike.%${search}%,product_code.ilike.%${search}%`
      );
    }
    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ products: data || [] });
  } catch (err) {
    console.error('[business/products] error:', err);
    res.status(500).json({ error: 'Failed to look up products' });
  }
});

/**
 * GET /api/business/customers/:customerId/orders?months=6
 * Get order history for a customer with product details.
 */
router.get('/customers/:customerId/orders', async (req, res) => {
  try {
    const { customerId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    let query = supabase
      .from('sc_customer_orders')
      .select('*, sc_products(product_name, product_code, category, sell_price_usd, cost_usd, margin_pct)')
      .eq('account_id', req.account.id)
      .eq('customer_id', customerId)
      .order('order_date', { ascending: false })
      .limit(limit);

    // Optional date filter — only apply if explicitly provided
    if (req.query.months) {
      const months = parseInt(req.query.months);
      const sinceDate = new Date();
      sinceDate.setMonth(sinceDate.getMonth() - months);
      query = query.gte('order_date', sinceDate.toISOString().split('T')[0]);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json({ orders: data || [] });
  } catch (err) {
    console.error('[business/customer-orders] error:', err);
    res.status(500).json({ error: 'Failed to get customer orders' });
  }
});

/**
 * GET /api/business/customers/:customerId/margin-analysis
 * Analyze margin per product for a customer and suggest higher-margin alternatives.
 */
router.get('/customers/:customerId/margin-analysis', async (req, res) => {
  try {
    const { customerId } = req.params;

    // Get customer info
    const { data: customer } = await supabase
      .from('sc_customers')
      .select('*')
      .eq('id', customerId)
      .eq('account_id', req.account.id)
      .single();

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get their order history aggregated by product
    const { data: orders, error: ordersError } = await supabase
      .from('sc_customer_orders')
      .select('product_id, quantity, unit_price_usd, line_total_usd, margin_pct, sc_products(product_name, product_code, category, sell_price_usd, cost_usd, margin_pct)')
      .eq('account_id', req.account.id)
      .eq('customer_id', customerId);

    if (ordersError) throw ordersError;

    // Aggregate by product
    const productMap = {};
    for (const order of (orders || [])) {
      const pid = order.product_id;
      if (!productMap[pid]) {
        productMap[pid] = {
          product: order.sc_products,
          total_qty: 0,
          total_revenue: 0,
          avg_unit_price: 0,
          avg_margin_pct: 0,
          order_count: 0,
        };
      }
      productMap[pid].total_qty += parseFloat(order.quantity);
      productMap[pid].total_revenue += parseFloat(order.line_total_usd);
      productMap[pid].avg_margin_pct += parseFloat(order.margin_pct || 0);
      productMap[pid].order_count += 1;
    }

    // Calculate averages
    const purchasedProducts = Object.values(productMap).map((p) => {
      p.avg_unit_price = p.total_revenue / p.total_qty;
      p.avg_margin_pct = p.avg_margin_pct / p.order_count;
      return p;
    });

    // Sort by margin (lowest first — biggest optimization opportunity)
    purchasedProducts.sort((a, b) => a.avg_margin_pct - b.avg_margin_pct);

    // For low-margin items, find higher-margin alternatives in same category
    const lowMarginItems = purchasedProducts.filter(p => p.avg_margin_pct < 40);
    const alternatives = [];

    for (const item of lowMarginItems) {
      if (!item.product?.category) continue;
      const { data: altProducts } = await supabase
        .from('sc_products')
        .select('*')
        .eq('account_id', req.account.id)
        .eq('category', item.product.category)
        .eq('is_active', true)
        .gt('margin_pct', item.avg_margin_pct)
        .order('margin_pct', { ascending: false })
        .limit(3);

      if (altProducts && altProducts.length > 0) {
        alternatives.push({
          current_product: item.product?.product_name,
          current_margin: Math.round(item.avg_margin_pct * 100) / 100,
          current_revenue: Math.round(item.total_revenue * 100) / 100,
          alternatives: altProducts.map(a => ({
            product_name: a.product_name,
            sell_price: a.sell_price_usd,
            cost: a.cost_usd,
            margin_pct: a.margin_pct,
          })),
        });
      }
    }

    res.json({
      customer: { name: customer.customer_name, code: customer.customer_code, type: customer.customer_type },
      summary: {
        total_products: purchasedProducts.length,
        total_revenue: Math.round(purchasedProducts.reduce((s, p) => s + p.total_revenue, 0) * 100) / 100,
        avg_margin: purchasedProducts.length > 0
          ? Math.round(purchasedProducts.reduce((s, p) => s + p.avg_margin_pct, 0) / purchasedProducts.length * 100) / 100
          : 0,
        low_margin_count: lowMarginItems.length,
      },
      products: purchasedProducts.map(p => ({
        product_name: p.product?.product_name,
        product_code: p.product?.product_code,
        category: p.product?.category,
        total_qty: p.total_qty,
        total_revenue: Math.round(p.total_revenue * 100) / 100,
        avg_unit_price: Math.round(p.avg_unit_price * 10000) / 10000,
        avg_margin_pct: Math.round(p.avg_margin_pct * 100) / 100,
        list_price: p.product?.sell_price_usd,
        cost: p.product?.cost_usd,
      })),
      margin_opportunities: alternatives,
    });
  } catch (err) {
    console.error('[business/margin-analysis] error:', err);
    res.status(500).json({ error: 'Failed to generate margin analysis' });
  }
});

/**
 * GET /api/business/sales-summary?sort_by=revenue|margin|orders&limit=20
 * Aggregate sales across all customers — total revenue, avg margin, order count per customer.
 */
router.get('/sales-summary', async (req, res) => {
  try {
    const sortBy = req.query.sort_by || 'revenue';
    const limit = parseInt(req.query.limit) || 20;

    // Get all orders with customer and product info
    const { data: orders, error } = await supabase
      .from('sc_customer_orders')
      .select('customer_id, quantity, unit_price_usd, line_total_usd, margin_pct, cost_usd, sc_customers(customer_name, customer_code, customer_type), sc_products(product_name, category)')
      .eq('account_id', req.account.id);

    if (error) throw error;

    // Aggregate by customer
    const customerMap = {};
    for (const order of (orders || [])) {
      const cid = order.customer_id;
      if (!customerMap[cid]) {
        customerMap[cid] = {
          customer_id: cid,
          customer_name: order.sc_customers?.customer_name || 'Unknown',
          customer_code: order.sc_customers?.customer_code || '',
          customer_type: order.sc_customers?.customer_type || '',
          total_revenue: 0,
          total_cost: 0,
          total_orders: 0,
          total_units: 0,
          products_ordered: new Set(),
        };
      }
      const c = customerMap[cid];
      c.total_revenue += parseFloat(order.line_total_usd || 0);
      c.total_cost += parseFloat(order.cost_usd || 0);
      c.total_orders += 1;
      c.total_units += parseFloat(order.quantity || 0);
      if (order.sc_products?.product_name) c.products_ordered.add(order.sc_products.product_name);
    }

    // Calculate margins and format
    let customers = Object.values(customerMap).map((c) => ({
      customer_id: c.customer_id,
      customer_name: c.customer_name,
      customer_code: c.customer_code,
      customer_type: c.customer_type,
      total_revenue: Math.round(c.total_revenue * 100) / 100,
      total_cost: Math.round(c.total_cost * 100) / 100,
      gross_profit: Math.round((c.total_revenue - c.total_cost) * 100) / 100,
      avg_margin_pct: c.total_revenue > 0
        ? Math.round(((c.total_revenue - c.total_cost) / c.total_revenue * 100) * 100) / 100
        : 0,
      total_orders: c.total_orders,
      total_units: c.total_units,
      unique_products: c.products_ordered.size,
    }));

    // Sort
    if (sortBy === 'margin') {
      customers.sort((a, b) => b.avg_margin_pct - a.avg_margin_pct);
    } else if (sortBy === 'orders') {
      customers.sort((a, b) => b.total_orders - a.total_orders);
    } else {
      customers.sort((a, b) => b.total_revenue - a.total_revenue);
    }

    customers = customers.slice(0, limit);

    // Overall totals
    const totals = {
      total_customers: customers.length,
      total_revenue: Math.round(customers.reduce((s, c) => s + c.total_revenue, 0) * 100) / 100,
      total_cost: Math.round(customers.reduce((s, c) => s + c.total_cost, 0) * 100) / 100,
      total_orders: customers.reduce((s, c) => s + c.total_orders, 0),
      avg_margin_pct: customers.length > 0
        ? Math.round(customers.reduce((s, c) => s + c.avg_margin_pct, 0) / customers.length * 100) / 100
        : 0,
    };
    totals.gross_profit = Math.round((totals.total_revenue - totals.total_cost) * 100) / 100;

    res.json({ totals, customers });
  } catch (err) {
    console.error('[business/sales-summary] error:', err);
    res.status(500).json({ error: 'Failed to generate sales summary' });
  }
});

/**
 * GET /api/business/product-performance?sort_by=revenue|margin|units&limit=20
 * Aggregate sales by product across all customers.
 */
router.get('/product-performance', async (req, res) => {
  try {
    const sortBy = req.query.sort_by || 'revenue';
    const limit = parseInt(req.query.limit) || 20;

    const { data: orders, error } = await supabase
      .from('sc_customer_orders')
      .select('product_id, quantity, unit_price_usd, line_total_usd, margin_pct, cost_usd, sc_products(product_name, product_code, category, sell_price_usd, cost_usd, margin_pct)')
      .eq('account_id', req.account.id);

    if (error) throw error;

    const productMap = {};
    for (const order of (orders || [])) {
      const pid = order.product_id;
      if (!productMap[pid]) {
        productMap[pid] = {
          product_name: order.sc_products?.product_name || 'Unknown',
          product_code: order.sc_products?.product_code || '',
          category: order.sc_products?.category || '',
          list_price: order.sc_products?.sell_price_usd,
          standard_cost: order.sc_products?.cost_usd,
          standard_margin: order.sc_products?.margin_pct,
          total_revenue: 0,
          total_cost: 0,
          total_units: 0,
          total_orders: 0,
          customers: new Set(),
        };
      }
      const p = productMap[pid];
      p.total_revenue += parseFloat(order.line_total_usd || 0);
      p.total_cost += parseFloat(order.cost_usd || 0);
      p.total_units += parseFloat(order.quantity || 0);
      p.total_orders += 1;
      if (order.customer_id) p.customers.add(order.customer_id);
    }

    let products = Object.values(productMap).map((p) => ({
      product_name: p.product_name,
      product_code: p.product_code,
      category: p.category,
      list_price: p.list_price,
      standard_margin_pct: p.standard_margin,
      total_revenue: Math.round(p.total_revenue * 100) / 100,
      total_cost: Math.round(p.total_cost * 100) / 100,
      gross_profit: Math.round((p.total_revenue - p.total_cost) * 100) / 100,
      avg_realized_margin_pct: p.total_revenue > 0
        ? Math.round(((p.total_revenue - p.total_cost) / p.total_revenue * 100) * 100) / 100
        : 0,
      total_units: p.total_units,
      total_orders: p.total_orders,
      customer_count: p.customers.size,
    }));

    if (sortBy === 'margin') {
      products.sort((a, b) => b.avg_realized_margin_pct - a.avg_realized_margin_pct);
    } else if (sortBy === 'units') {
      products.sort((a, b) => b.total_units - a.total_units);
    } else {
      products.sort((a, b) => b.total_revenue - a.total_revenue);
    }

    products = products.slice(0, limit);

    res.json({ products });
  } catch (err) {
    console.error('[business/product-performance] error:', err);
    res.status(500).json({ error: 'Failed to generate product performance report' });
  }
});

/**
 * GET /api/business/vendor-pricing?ingredient=...
 * Compare vendor prices for an ingredient.
 * Two-step: find matching ingredients first, then get their pricing.
 */
router.get('/vendor-pricing', async (req, res) => {
  try {
    const { ingredient } = req.query;
    if (!ingredient) {
      return res.status(400).json({ error: 'ingredient search term required' });
    }

    // Step 1: Find matching ingredients by name or code
    const { data: ingredients, error: ingError } = await supabase
      .from('sc_ingredients')
      .select('id, ingredient_name, ingredient_code, category')
      .eq('account_id', req.account.id)
      .or(`ingredient_name.ilike.%${ingredient}%,ingredient_code.ilike.%${ingredient}%`);

    if (ingError) throw ingError;

    if (!ingredients || ingredients.length === 0) {
      return res.json({ pricing: [], message: `No ingredients found matching "${ingredient}"` });
    }

    // Step 2: Get vendor pricing for all matching ingredient IDs
    const ingredientIds = ingredients.map(i => i.id);
    const { data: pricing, error: priceError } = await supabase
      .from('sc_vendor_pricing')
      .select('*, sc_vendors(vendor_name, vendor_code, lead_time_days, rating)')
      .eq('account_id', req.account.id)
      .in('ingredient_id', ingredientIds)
      .order('unit_cost_usd', { ascending: true });

    if (priceError) throw priceError;

    // Build ingredient lookup map
    const ingMap = {};
    for (const ing of ingredients) ingMap[ing.id] = ing;

    res.json({
      pricing: (pricing || []).map(d => ({
        vendor: d.sc_vendors?.vendor_name,
        vendor_code: d.sc_vendors?.vendor_code,
        ingredient: ingMap[d.ingredient_id]?.ingredient_name,
        ingredient_code: ingMap[d.ingredient_id]?.ingredient_code,
        category: ingMap[d.ingredient_id]?.category,
        unit_cost_usd: d.unit_cost_usd,
        pack_size: d.pack_size,
        is_preferred: d.is_preferred,
        lead_time_days: d.sc_vendors?.lead_time_days,
        vendor_rating: d.sc_vendors?.rating,
      })),
    });
  } catch (err) {
    console.error('[business/vendor-pricing] error:', err);
    res.status(500).json({ error: 'Failed to get vendor pricing' });
  }
});

/**
 * POST /api/business/query
 * Flexible Supabase query builder for the sc_ tables.
 * The AI specifies table, select, filters, ordering — we build and execute.
 *
 * Body: { table, select?, filters?, order_by?, ascending?, limit? }
 *
 * Safety: only sc_ tables, read-only, account-scoped, max 100 rows.
 */
router.post('/query', async (req, res) => {
  try {
    const { table, select = '*', filters = {}, order_by, ascending = true, limit = 50 } = req.body;

    if (!table || typeof table !== 'string') {
      return res.status(400).json({ error: 'table name is required' });
    }

    const allowedTables = [
      'sc_vendors', 'sc_ingredients', 'sc_vendor_pricing', 'sc_products',
      'sc_recipes', 'sc_customers', 'sc_supply_orders', 'sc_customer_orders',
      'sc_quotes', 'sc_quote_items', 'sc_sales_transactions',
    ];
    if (!allowedTables.includes(table)) {
      return res.status(400).json({ error: `Unknown or disallowed table: ${table}` });
    }

    let query = supabase
      .from(table)
      .select(select)
      .eq('account_id', req.account.id)
      .limit(Math.min(limit || 50, 100));

    // Apply filters
    for (const [key, value] of Object.entries(filters)) {
      if (key.endsWith('.ilike')) {
        query = query.ilike(key.replace('.ilike', ''), value);
      } else if (key.endsWith('.gt')) {
        query = query.gt(key.replace('.gt', ''), value);
      } else if (key.endsWith('.lt')) {
        query = query.lt(key.replace('.lt', ''), value);
      } else if (key.endsWith('.gte')) {
        query = query.gte(key.replace('.gte', ''), value);
      } else if (key.endsWith('.lte')) {
        query = query.lte(key.replace('.lte', ''), value);
      } else if (key.endsWith('.neq')) {
        query = query.neq(key.replace('.neq', ''), value);
      } else {
        query = query.eq(key, value);
      }
    }

    if (order_by) {
      query = query.order(order_by, { ascending: ascending !== false });
    }

    const { data, error } = await query;

    if (error) {
      console.error('[business/query] Supabase error:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ rows: data || [], count: (data || []).length });
  } catch (err) {
    console.error('[business/query] error:', err);
    res.status(500).json({ error: err.message || 'Query execution failed' });
  }
});

/**
 * GET /api/business/schema
 * Returns the sc_ table schemas so the AI can reference them.
 */
// ─── Quote Management ─────────────────────────────────────────────────────

/**
 * POST /api/business/quotes
 * Create a new quote with line items.
 *
 * Body: {
 *   customer_id: UUID,
 *   items: [{ product_id?, product_name, quantity, unit_price? }],
 *   notes?: string,
 *   valid_days?: number (default 30)
 * }
 *
 * Auto-resolves product pricing if unit_price not provided.
 * Applies customer discount. Calculates line totals and quote total.
 */
router.post('/quotes', async (req, res) => {
  try {
    const { customer_id, items, notes, valid_days = 30 } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required with at least one item' });
    }

    // Fetch customer for discount and details
    const { data: customer, error: custError } = await supabase
      .from('sc_customers')
      .select('*')
      .eq('id', customer_id)
      .eq('account_id', req.account.id)
      .single();

    if (custError || !customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Generate quote number: QUO-YYYYMMDD-XXX
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const { count } = await supabase
      .from('sc_quotes')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', req.account.id);
    const seqNum = String((count || 0) + 1).padStart(3, '0');
    const quoteNumber = `QUO-${dateStr}-${seqNum}`;

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + valid_days);

    // Resolve product details for each line item
    const lineItems = [];
    let subtotal = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let product = null;
      let unitPrice = item.unit_price;
      let costPerUnit = 0;
      let description = item.product_name || item.description || `Item ${i + 1}`;

      // Look up product by ID or name
      if (item.product_id) {
        const { data } = await supabase
          .from('sc_products')
          .select('*')
          .eq('id', item.product_id)
          .eq('account_id', req.account.id)
          .single();
        product = data;
      } else if (item.product_name) {
        const { data } = await supabase
          .from('sc_products')
          .select('*')
          .eq('account_id', req.account.id)
          .ilike('product_name', `%${item.product_name}%`)
          .limit(1)
          .single();
        product = data;
      }

      if (product) {
        description = product.product_name;
        if (!unitPrice) unitPrice = parseFloat(product.sell_price_usd);
        costPerUnit = parseFloat(product.cost_usd || 0);
      }

      if (!unitPrice) {
        return res.status(400).json({ error: `Could not determine price for item: ${description}` });
      }

      const qty = parseFloat(item.quantity);
      const lineTotal = Math.round(qty * unitPrice * 100) / 100;
      subtotal += lineTotal;

      lineItems.push({
        product_id: product?.id || null,
        description,
        quantity: qty,
        unit_price_usd: unitPrice,
        line_total_usd: lineTotal,
        cost_usd: costPerUnit * qty,
        sort_order: i,
      });
    }

    // Apply customer discount
    const discountPct = parseFloat(customer.discount_pct || 0);
    const discountAmount = Math.round(subtotal * (discountPct / 100) * 100) / 100;
    const total = Math.round((subtotal - discountAmount) * 100) / 100;

    // Create quote header
    const { data: quote, error: quoteError } = await supabase
      .from('sc_quotes')
      .insert({
        account_id: req.account.id,
        quote_number: quoteNumber,
        customer_id: customer.id,
        status: 'draft',
        quote_date: new Date().toISOString().split('T')[0],
        valid_until: validUntil.toISOString().split('T')[0],
        subtotal_usd: subtotal,
        discount_pct: discountPct,
        total_usd: total,
        notes: notes || null,
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (quoteError) {
      console.error('[business/quotes] Error creating quote:', quoteError);
      return res.status(500).json({ error: quoteError.message });
    }

    // Create line items
    const itemRows = lineItems.map(item => ({
      account_id: req.account.id,
      quote_id: quote.id,
      ...item,
    }));

    const { data: savedItems, error: itemsError } = await supabase
      .from('sc_quote_items')
      .insert(itemRows)
      .select('*');

    if (itemsError) {
      console.error('[business/quotes] Error creating line items:', itemsError);
      // Clean up the quote header
      await supabase.from('sc_quotes').delete().eq('id', quote.id);
      return res.status(500).json({ error: itemsError.message });
    }

    // Calculate total cost and margin for the quote
    const totalCost = lineItems.reduce((sum, li) => sum + (li.cost_usd || 0), 0);
    const quoteMargin = total > 0 ? Math.round(((total - totalCost) / total * 100) * 100) / 100 : 0;

    res.json({
      quote: {
        ...quote,
        customer_name: customer.customer_name,
        customer_email: customer.email,
        contact_name: customer.contact_name,
        payment_terms: customer.payment_terms,
      },
      items: savedItems,
      summary: {
        subtotal: subtotal,
        discount_pct: discountPct,
        discount_amount: discountAmount,
        total: total,
        total_cost: Math.round(totalCost * 100) / 100,
        gross_profit: Math.round((total - totalCost) * 100) / 100,
        margin_pct: quoteMargin,
        item_count: lineItems.length,
        total_units: lineItems.reduce((sum, li) => sum + li.quantity, 0),
      },
    });
  } catch (err) {
    console.error('[business/quotes] error:', err);
    res.status(500).json({ error: err.message || 'Failed to create quote' });
  }
});

/**
 * GET /api/business/quotes/:id
 * Retrieve a quote with its line items and customer info.
 */
router.get('/quotes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: quote, error: quoteError } = await supabase
      .from('sc_quotes')
      .select('*, sc_customers(customer_name, contact_name, email, phone, address, payment_terms, discount_pct)')
      .eq('id', id)
      .eq('account_id', req.account.id)
      .single();

    if (quoteError || !quote) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const { data: items, error: itemsError } = await supabase
      .from('sc_quote_items')
      .select('*, sc_products(product_name, product_code, category)')
      .eq('quote_id', id)
      .eq('account_id', req.account.id)
      .order('sort_order', { ascending: true });

    if (itemsError) throw itemsError;

    res.json({ quote, items: items || [] });
  } catch (err) {
    console.error('[business/quotes/:id] error:', err);
    res.status(500).json({ error: 'Failed to retrieve quote' });
  }
});

/**
 * GET /api/business/quotes
 * List quotes for the account, with optional status filter.
 */
router.get('/quotes', async (req, res) => {
  try {
    const { status, limit = 20 } = req.query;

    let query = supabase
      .from('sc_quotes')
      .select('*, sc_customers(customer_name)')
      .eq('account_id', req.account.id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit) || 20);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ quotes: data || [] });
  } catch (err) {
    console.error('[business/quotes] error:', err);
    res.status(500).json({ error: 'Failed to list quotes' });
  }
});

router.get('/schema', async (req, res) => {
  res.json({
    tables: {
      sc_vendors: {
        description: 'Suppliers / vendors',
        columns: 'id, account_id, vendor_code, vendor_name, category, contact_name, email, phone, lead_time_days, payment_terms, rating, is_active',
      },
      sc_ingredients: {
        description: 'Raw materials and ingredients',
        columns: 'id, account_id, ingredient_code, ingredient_name, category, unit',
      },
      sc_vendor_pricing: {
        description: 'Cost per ingredient per vendor (multiple vendors per item)',
        columns: 'id, account_id, vendor_id (FK→sc_vendors), ingredient_id (FK→sc_ingredients), unit_cost_usd, pack_size, is_preferred',
      },
      sc_products: {
        description: 'Sellable products / menu items with pricing',
        columns: 'id, account_id, product_code, product_name, category, sell_price_usd, cost_usd (COGS), margin_pct, is_active',
      },
      sc_recipes: {
        description: 'Bill of materials — ingredients per product',
        columns: 'id, account_id, product_id (FK→sc_products), ingredient_id (FK→sc_ingredients), qty, unit',
      },
      sc_customers: {
        description: 'B2B wholesale customers',
        columns: 'id, account_id, customer_code, customer_name, contact_name, email, phone, address, customer_type (cafe/restaurant/hotel/office/retail/wholesale), payment_terms, discount_pct, is_active',
      },
      sc_supply_orders: {
        description: 'Purchase orders to vendors',
        columns: 'id, account_id, order_code, order_date, vendor_id (FK→sc_vendors), ingredient_id (FK→sc_ingredients), qty_ordered, unit, unit_cost_usd, total_cost_usd, expected_delivery, status (Pending/In Transit/Delivered/Cancelled)',
      },
      sc_customer_orders: {
        description: 'B2B sales to customers',
        columns: 'id, account_id, order_code, customer_id (FK→sc_customers), product_id (FK→sc_products), order_date, quantity, unit_price_usd, cost_usd, line_total_usd, margin_pct',
      },
      sc_quotes: {
        description: 'Quote headers',
        columns: 'id, account_id, quote_number, customer_id (FK→sc_customers), status (draft/sent/accepted/rejected/expired), quote_date, valid_until, subtotal_usd, discount_pct, total_usd, notes, created_by',
      },
      sc_quote_items: {
        description: 'Quote line items',
        columns: 'id, account_id, quote_id (FK→sc_quotes), product_id (FK→sc_products), description, quantity, unit_price_usd, line_total_usd, cost_usd, sort_order',
      },
      sc_sales_transactions: {
        description: 'POS retail sales (individual transactions)',
        columns: 'id, account_id, sale_date, sale_datetime, payment_type (card/cash), card_token, amount_usd, product_name',
      },
    },
  });
});

export default router;
