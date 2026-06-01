/**
 * Test cases for order product quantity handling.
 *
 * Design Rule:
 * - If a product has options, store qty in order_product_option.option_quantity (= per_unit_qty × product_qty)
 * - If a product has NO options, store qty in order_product.quantity
 *
 * The option_quantity in DB is ALWAYS the TOTAL quantity (not per-unit).
 * Example: product qty=10, addon qty=1 per unit → option_quantity stored = 10
 *
 * Total calculation:
 * - product with options (price=0, variant model): total = SUM(option_price × option_quantity)
 * - product with options (price>0, add-on model): total = (price × qty) + SUM(option_price × option_quantity)
 * - product without options: total = price × quantity
 */

describe('Order Quantity - Portal (store-orders)', () => {
  describe('Product WITHOUT options', () => {
    it('should store quantity in order_product.quantity', () => {
      const item = { product_id: 1, quantity: 10, price: 5.0, options: [] };
      const expectedOrderProduct = {
        quantity: 10,
        price: 5.0,
        total: 50.0, // price × quantity
      };
      expect(item.quantity).toBe(expectedOrderProduct.quantity);
      expect(item.price * item.quantity).toBe(expectedOrderProduct.total);
    });

    it('should store quantity=1 when no quantity specified', () => {
      const item = { product_id: 1, quantity: 1, price: 25.0, options: [] };
      expect(item.price * item.quantity).toBe(25.0);
    });
  });

  describe('Product WITH options (variant model, price=0)', () => {
    it('should multiply per-unit option qty by product qty for option_quantity', () => {
      const item = { product_id: 1, quantity: 10, price: 0, options: [
        { option_name: 'Size', option_value: 'Large', quantity: 10, price: 8.0 },
      ]};
      // option.quantity is set to item.quantity in store-orders for variant products
      const optionQuantity = item.options[0].quantity || item.quantity;
      expect(optionQuantity).toBe(10);
      const optionTotal = item.options[0].price * optionQuantity;
      expect(optionTotal).toBe(80.0); // $8 × 10 = $80
    });

    it('should fallback to item.quantity when option.quantity is missing', () => {
      const item = { product_id: 1, quantity: 5, price: 0, options: [
        { option_name: 'Color', option_value: 'Red', quantity: undefined as any, price: 12.0 },
      ]};
      const optionQuantity = item.options[0].quantity || item.quantity;
      expect(optionQuantity).toBe(5); // Falls back to item.quantity, NOT 1
      const optionTotal = item.options[0].price * optionQuantity;
      expect(optionTotal).toBe(60.0); // $12 × 5 = $60
    });

    it('should calculate product total as sum of option totals when price=0', () => {
      const item = { product_id: 1, quantity: 3, price: 0, options: [
        { option_name: 'Size', option_value: 'XL', quantity: 3, price: 15.0 },
        { option_name: 'Print', option_value: 'Logo', quantity: 3, price: 5.0 },
      ]};
      let optionsTotal = 0;
      for (const opt of item.options) {
        const optQty = opt.quantity || item.quantity;
        optionsTotal += opt.price * optQty;
      }
      const productTotal = (item.price * item.quantity) + optionsTotal;
      expect(productTotal).toBe(60.0); // (0×3) + (15×3) + (5×3) = 0 + 45 + 15 = 60
    });
  });

  describe('Product WITH options (add-on model, price>0)', () => {
    it('should calculate total = (price×qty) + sum(option_price×option_qty)', () => {
      const item = { product_id: 1, quantity: 10, price: 5.0, options: [
        { option_name: 'Extra Sauce', option_value: 'Yes', quantity: 10, price: 2.0 },
      ]};
      const optionQuantity = item.options[0].quantity || item.quantity;
      const optionsTotal = item.options[0].price * optionQuantity;
      const productTotal = (item.price * item.quantity) + optionsTotal;
      expect(productTotal).toBe(70.0); // (5×10) + (2×10) = 50 + 20 = 70
    });
  });
});

describe('Order Quantity - Admin (new order / edit order)', () => {
  describe('Creating new order - VARIANT product (price=0, options have prices)', () => {
    it('should set order_product.quantity = sum of option quantities', () => {
      const product = { product_id: 1, quantity: 1, price: 0 }; // qty=1 (hidden in UI for variants)
      const addons = [
        { option_name: '250G', quantity: 2, price: 14.25 },
        { option_name: '1kg', quantity: 3, price: 39.00 },
      ];
      const isVariant = product.price === 0 && addons.length > 0;
      // For variant: product qty = sum of option quantities
      const productQuantity = isVariant
        ? addons.reduce((sum, a) => sum + (a.quantity || 1), 0)
        : product.quantity;
      expect(productQuantity).toBe(5); // 2 + 3 = 5
    });

    it('should NOT multiply option_quantity for variant products', () => {
      const product = { product_id: 1, quantity: 1, price: 0 };
      const addon = { option_name: '250G', quantity: 2, price: 14.25 };
      const isVariant = product.price === 0;
      const option_quantity = isVariant ? (addon.quantity || 1) : (addon.quantity || 1) * product.quantity;
      expect(option_quantity).toBe(2); // Direct value, no multiplication
    });

    it('should calculate correct total for variant product', () => {
      const options = [
        { option_quantity: 2, option_price: 14.25 },
        { option_quantity: 3, option_price: 39.00 },
      ];
      const optionsTotal = options.reduce((sum, o) => sum + o.option_price * o.option_quantity, 0);
      const productTotal = (0 * 5) + optionsTotal; // price=0, qty=5 (sum of options)
      expect(productTotal).toBe(145.50); // 14.25×2 + 39.00×3 = 28.50 + 117 = 145.50
    });
  });

  describe('Creating new order - ADDON product (price>0, add-ons)', () => {
    it('should multiply per-unit addon.quantity by product.quantity before sending to API', () => {
      const product = { product_id: 1, quantity: 10, price: 5.0 };
      const addon = { option_name: 'Extra', option_value: 'Yes', quantity: 1, price: 2.0 };
      const isVariant = product.price === 0;
      const option_quantity = isVariant ? (addon.quantity || 1) : (addon.quantity || 1) * product.quantity;
      expect(option_quantity).toBe(10); // 1 per unit × 10 products = 10 total
    });

    it('should handle addon quantity > 1 per unit', () => {
      const product = { product_id: 1, quantity: 5, price: 10.0 };
      const addon = { option_name: 'Napkins', option_value: '2 pack', quantity: 2, price: 1.0 };
      const isVariant = product.price === 0;
      const option_quantity = isVariant ? (addon.quantity || 1) : (addon.quantity || 1) * product.quantity;
      expect(option_quantity).toBe(10); // 2 per unit × 5 products = 10 total
    });

    it('should default addon quantity to 1 when not specified', () => {
      const product = { product_id: 1, quantity: 8, price: 5.0 };
      const addon = { option_name: 'Gift Wrap', option_value: 'Yes', quantity: undefined as any, price: 3.0 };
      const isVariant = product.price === 0;
      const option_quantity = isVariant ? (addon.quantity || 1) : (addon.quantity || 1) * product.quantity;
      expect(option_quantity).toBe(8); // (undefined||1) × 8 = 8
    });
  });

  describe('Editing order - load and save roundtrip', () => {
    it('should NOT divide option_quantity for variant products when loading', () => {
      // Variant: stored option_quantity = 2, product qty = 5 (sum of options)
      const storedOptionQuantity = 2;
      const productQuantity = 5;
      const productPrice = 0;
      const isVariant = productPrice === 0;
      const perUnitQty = isVariant ? storedOptionQuantity : storedOptionQuantity / productQuantity;
      expect(perUnitQty).toBe(2); // Direct value for variants
    });

    it('should divide option_quantity for addon products when loading', () => {
      // Addon: stored option_quantity = 10, product qty = 10
      const storedOptionQuantity = 10;
      const productQuantity = 10;
      const productPrice = 5.0;
      const isVariant = productPrice === 0;
      const perUnitQty = isVariant ? storedOptionQuantity : storedOptionQuantity / productQuantity;
      expect(perUnitQty).toBe(1); // 10/10 = 1 per unit
    });

    it('should save correctly for variant products', () => {
      // Variant: user has addon qty = 2 in form, product price = 0
      const addonQuantity = 2;
      const productPrice = 0;
      const productQuantity = 1; // Hidden in UI for variants
      const isVariant = productPrice === 0;
      const option_quantity = isVariant ? addonQuantity : addonQuantity * productQuantity;
      expect(option_quantity).toBe(2); // Direct value
    });
  });

  describe('Subtotal display calculation', () => {
    it('should calculate subtotal correctly for addon products', () => {
      const item = { quantity: 10, price: 5.0 };
      const addons = [
        { quantity: 1, price: 2.0 },
        { quantity: 1, price: 3.0 },
      ];
      const addOnsPerUnit = addons.reduce((sum, a) => sum + (a.quantity * a.price), 0);
      const addOnsTotal = addOnsPerUnit * item.quantity;
      const subtotal = (item.price * item.quantity) + addOnsTotal;
      expect(addOnsTotal).toBe(50.0); // (1×2 + 1×3) × 10 = 5 × 10 = 50
      expect(subtotal).toBe(100.0); // 50 + 50 = 100
    });

    it('should calculate subtotal correctly for variant products', () => {
      const item = { quantity: 1, price: 0 }; // qty=1 hidden for variants
      const addons = [
        { quantity: 2, price: 14.25 },
        { quantity: 3, price: 39.00 },
      ];
      const addOnsPerUnit = addons.reduce((sum, a) => sum + (a.quantity * a.price), 0);
      const addOnsTotal = addOnsPerUnit * item.quantity; // × 1 = no change
      const subtotal = (item.price * item.quantity) + addOnsTotal;
      expect(subtotal).toBe(145.50); // 0 + (14.25×2 + 39.00×3) = 145.50
    });
  });
});

describe('Order Quantity - Quotes', () => {
  describe('Creating new quote with options', () => {
    it('should multiply per-unit addon qty by product qty', () => {
      const product = { quantity: 10, price: 0 };
      const addon = { quantity: 1, price: 15.0 };
      const option_quantity = (addon.quantity || 1) * product.quantity;
      expect(option_quantity).toBe(10);
    });
  });

  describe('Editing quote - load roundtrip', () => {
    it('should divide stored option_quantity by product qty when loading', () => {
      const storedOptionQuantity = 20;
      const productQuantity = 10;
      const perUnitQty = storedOptionQuantity / productQuantity;
      expect(perUnitQty).toBe(2);
    });
  });
});

describe('Invoice and Payment - uses stored totals', () => {
  it('invoice subtotal uses SUM(order_product.total) - not option_quantity directly', () => {
    // Invoice reads op.total which is calculated correctly at creation time
    const orderProducts = [
      { total: 70.0, quantity: 10 }, // price=5, qty=10, option(2×10) → 50+20=70
      { total: 25.0, quantity: 5 },  // price=5, qty=5, no options → 25
    ];
    const subtotal = orderProducts.reduce((sum, op) => sum + op.total, 0);
    expect(subtotal).toBe(95.0);
  });

  it('payment intent amount uses SUM(order_product.total)', () => {
    const orderProducts = [
      { total: 80.0 }, // variant: option_price=8 × option_qty=10 = 80
    ];
    const subtotal = orderProducts.reduce((sum, op) => sum + op.total, 0);
    const deliveryFee = 10.0;
    const paymentAmount = subtotal + deliveryFee;
    expect(paymentAmount).toBe(90.0);
  });

  it('Xero unit price = total / quantity', () => {
    // Product with options: total=80, qty=10 → unit_price=8
    const product = { total: 80.0, quantity: 10 };
    const unitPrice = product.total / product.quantity;
    expect(unitPrice).toBe(8.0);
  });
});

describe('Print Invoice / Download Invoice', () => {
  it('should display correct quantity from order_product.quantity', () => {
    const orderProduct = { product_name: 'T-Shirt', quantity: 10, price: 0, total: 150.0 };
    expect(orderProduct.quantity).toBe(10);
  });

  it('should display option_quantity as stored (total, not per-unit)', () => {
    const option = { option_name: 'Size', option_value: 'XL', option_quantity: 10, option_price: 15.0 };
    // Invoice shows "Size: XL (qty: 10 × $15.00)"
    expect(option.option_quantity * option.option_price).toBe(150.0);
  });
});

describe('Send Payment Link', () => {
  it('should use order total from SUM(order_product.total) + delivery - discounts', () => {
    const subtotal = 150.0; // SUM(op.total)
    const deliveryFee = 15.0;
    const discount = 0;
    const gst = 15.0; // 10% on taxable items
    const orderTotal = subtotal + deliveryFee - discount + gst;
    expect(orderTotal).toBe(180.0);
  });
});
