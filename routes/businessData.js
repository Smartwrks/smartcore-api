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
 */
router.get('/vendor-pricing', async (req, res) => {
  try {
    const { ingredient } = req.query;
    if (!ingredient) {
      return res.status(400).json({ error: 'ingredient search term required' });
    }

    const { data, error } = await supabase
      .from('sc_vendor_pricing')
      .select('*, sc_vendors(vendor_name, vendor_code, lead_time_days, rating), sc_ingredients(ingredient_name, ingredient_code, category)')
      .eq('account_id', req.account.id)
      .or(`sc_ingredients.ingredient_name.ilike.%${ingredient}%,sc_ingredients.ingredient_code.ilike.%${ingredient}%`);

    if (error) throw error;

    // Filter out results where the ingredient join didn't match
    const filtered = (data || []).filter(d => d.sc_ingredients);

    res.json({
      pricing: filtered.map(d => ({
        vendor: d.sc_vendors?.vendor_name,
        vendor_code: d.sc_vendors?.vendor_code,
        ingredient: d.sc_ingredients?.ingredient_name,
        ingredient_code: d.sc_ingredients?.ingredient_code,
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

export default router;
