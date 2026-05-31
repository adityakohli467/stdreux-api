import { InvoiceService } from './invoice.service';

/**
 * Test cases for order subtotal calculation.
 * 
 * The subtotal logic must handle two pricing models:
 * 1. Variant-based pricing: product.price=0, all pricing comes from options (e.g., "Size: 1kg" = $62)
 *    → order_product.total already includes option pricing, do NOT add options on top
 * 2. Add-on pricing: product.price > 0, options are additional charges (e.g., product $20 + sauce $2)
 *    → order_product.total = price × qty, options must be added on top
 */

function createMockDataSource(orderProducts: any[], options: any[], orderOverrides: any = {}) {
  return {
    query: jest.fn(async (query: string, params?: any[]) => {
      if (query.includes('FROM settings') && query.includes('setting_key')) {
        return [];
      }

      if (query.includes('FROM orders o') && query.includes('WHERE o.order_id = $1')) {
        return [
          {
            order_id: params?.[0],
            order_date: '2026-05-25T00:00:00.000Z',
            delivery_date: '2026-05-24',
            delivery_date_time: '2026-05-24T10:00:00.000Z',
            delivery_fee: '0.00',
            order_status: 2,
            payment_status: 'succeeded',
            payment_date: '2026-05-25T00:00:00.000Z',
            order_comments: null,
            delivery_address: 'Test Address',
            order_total: '196.00',
            customer_name: 'Test Customer',
            customer_email: 'test@example.com',
            customer_phone: '0419440859',
            customer_type: 'Retail',
            company_name: null,
            company_abn: null,
            department_name: null,
            location_name: 'Sydney',
            location_address: null,
            location_phone: null,
            location_email: null,
            location_abn: null,
            location_company_name: null,
            location_account_name: null,
            location_account_number: null,
            location_bsb: null,
            coupon_id: null,
            stored_coupon_discount: '0.00',
            coupon_code: null,
            coupon_type: null,
            coupon_discount: null,
            delivery_method: null,
            delivery_contact: null,
            delivery_details: null,
            amount_paid: '196.00',
            ...orderOverrides,
          },
        ];
      }

      if (query.includes('FROM order_product op') && query.includes('WHERE op.order_id = $1')) {
        return orderProducts;
      }

      if (query.includes('FROM order_product_option opo')) {
        return options;
      }

      throw new Error(`Unhandled query: ${query}`);
    }),
  } as any;
}

describe('Order Subtotal Calculation', () => {
  const orderRepository = {} as any;
  const s3Service = {} as any;
  const configService = { get: jest.fn() } as any;

  describe('Variant-based pricing (product.price = 0, options contain pricing)', () => {
    it('should NOT double-count option prices when product.price is 0 (Order #1038 scenario)', async () => {
      // Scenario: Product "Prime" with option "Size: 1 Kg" at $62, qty=3
      // DB: order_product.price=0, order_product.total=186 (3×62), option_price=62, option_quantity=1
      const orderProducts = [
        {
          product_name: 'Prime',
          quantity: '3',
          price: '0.0000',  // Price is 0 because pricing comes from options
          total: '186.0000', // Already includes option pricing: 3 × $62
          order_product_id: 1415,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const options = [
        {
          order_product_id: 1415,
          option_name: 'Prime Size',
          option_value: '1 Kg',
          option_quantity: 1,  // Stored as per-unit
          option_price: '62.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal should be $186.00 (NOT $248 which was the bug: $186 + $62)
      expect(data.subtotal).toBe(186);
      // Each item total should be 186 (product base total, NOT productBase + options)
      expect(data.items[0].total).toBe(186);
    });

    it('should handle variant pricing with option_quantity matching product quantity', async () => {
      // Scenario: option_quantity = 3 (matches product qty), option_price=62
      // optionsTotal = 62 × 3 = 186
      const orderProducts = [
        {
          product_name: 'Prime',
          quantity: '3',
          price: '0.0000',
          total: '186.0000',
          order_product_id: 100,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const options = [
        {
          order_product_id: 100,
          option_name: 'Prime Size',
          option_value: '1 Kg',
          option_quantity: 3,  // Matches product qty
          option_price: '62.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal should still be $186.00 (product total), NOT $186 + $186 = $372
      expect(data.subtotal).toBe(186);
    });

    it('should handle variant pricing with multiple options', async () => {
      // Scenario: Product with two variant options (e.g., Size and Cut)
      const orderProducts = [
        {
          product_name: 'Premium Steak',
          quantity: '2',
          price: '0.0000',
          total: '150.0000', // 2 × (50 + 25) = 150
          order_product_id: 101,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const options = [
        {
          order_product_id: 101,
          option_name: 'Size',
          option_value: '500g',
          option_quantity: 1,
          option_price: '50.00',
        },
        {
          order_product_id: 101,
          option_name: 'Cut',
          option_value: 'Scotch Fillet',
          option_quantity: 1,
          option_price: '25.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal should be $150 (product total), NOT $150 + $75 = $225
      expect(data.subtotal).toBe(150);
    });
  });

  describe('Add-on pricing (product.price > 0, options are additional)', () => {
    it('should add option prices on top when product has a base price', async () => {
      // Scenario: Steak $20 × 2 = $40, plus sauce add-on $3 × 1
      const orderProducts = [
        {
          product_name: 'Steak',
          quantity: '2',
          price: '20.00',
          total: '40.00',  // price × qty only
          order_product_id: 200,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const options = [
        {
          order_product_id: 200,
          option_name: 'Add-on',
          option_value: 'Extra Sauce',
          option_quantity: 1,
          option_price: '3.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal should be $43.00 ($40 base + $3 add-on)
      expect(data.subtotal).toBe(43);
      expect(data.items[0].total).toBe(43);
    });

    it('should handle multiple add-on options', async () => {
      // Scenario: Burger $15 × 1 = $15, plus cheese $2 + bacon $3
      const orderProducts = [
        {
          product_name: 'Burger',
          quantity: '1',
          price: '15.00',
          total: '15.00',
          order_product_id: 201,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const options = [
        {
          order_product_id: 201,
          option_name: 'Extra',
          option_value: 'Cheese',
          option_quantity: 1,
          option_price: '2.00',
        },
        {
          order_product_id: 201,
          option_name: 'Extra',
          option_value: 'Bacon',
          option_quantity: 1,
          option_price: '3.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal should be $20.00 ($15 base + $2 cheese + $3 bacon)
      expect(data.subtotal).toBe(20);
    });
  });

  describe('No options (simple product)', () => {
    it('should use product total directly when there are no options', async () => {
      const orderProducts = [
        {
          product_name: 'Coffee Beans',
          quantity: '2',
          price: '25.00',
          total: '50.00',
          order_product_id: 300,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, []);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal should be $50.00
      expect(data.subtotal).toBe(50);
      expect(data.items[0].total).toBe(50);
    });
  });

  describe('Mixed products in same order', () => {
    it('should correctly calculate subtotal with both variant and add-on products', async () => {
      // Order with:
      // 1. Prime (variant pricing): price=0, total=186, option: 1Kg @ $62, qty=3
      // 2. Sauce (add-on pricing): price=5, total=10, option: Extra Hot @ $1, qty=2
      const orderProducts = [
        {
          product_name: 'Prime',
          quantity: '3',
          price: '0.0000',
          total: '186.0000',
          order_product_id: 400,
          order_product_comment: null,
          category_names: '',
        },
        {
          product_name: 'Sauce',
          quantity: '2',
          price: '5.00',
          total: '10.00',
          order_product_id: 401,
          order_product_comment: null,
          category_names: '',
        },
      ];

      const options = [
        {
          order_product_id: 400,
          option_name: 'Size',
          option_value: '1 Kg',
          option_quantity: 1,
          option_price: '62.00',
        },
        {
          order_product_id: 401,
          option_name: 'Heat',
          option_value: 'Extra Hot',
          option_quantity: 1,
          option_price: '1.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Prime: $186 (variant, no double count)
      // Sauce: $10 + $1 = $11 (add-on)
      // Total: $186 + $11 = $197
      expect(data.subtotal).toBe(197);
      expect(data.items[0].total).toBe(186); // Prime
      expect(data.items[1].total).toBe(11);  // Sauce
    });
  });
});
