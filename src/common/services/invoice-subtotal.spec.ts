import { InvoiceService } from './invoice.service';

/**
 * Test cases for order subtotal calculation.
 *
 * The principle: order_product.total is ALWAYS the final line total including options.
 * Subtotal = SUM(order_product.total) — no complex heuristics needed.
 *
 * When orders are CREATED:
 * - If price > 0 (add-on model): total = (price * qty) + sum(option_price * option_qty)
 * - If price = 0 (variant model): total = sum(option_price * product_qty)
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

  describe('Variant-based pricing (product.price = 0, total includes option pricing)', () => {
    it('should use product.total directly - subtotal is just SUM(total)', async () => {
      // order_product.total = 186 (correctly stored as 3 x $62 at creation)
      const orderProducts = [
        {
          product_name: 'Prime',
          quantity: '3',
          price: '0.0000',
          total: '186.0000',
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
          option_quantity: 3,
          option_price: '62.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      expect(data.subtotal).toBe(186);
      expect(data.items[0].total).toBe(186);
    });
  });

  describe('Add-on pricing (product.price > 0, total includes base + options)', () => {
    it('should use product.total directly for add-on products', async () => {
      // total = (20*2) + (3*2) = 46, stored at creation
      const orderProducts = [
        {
          product_name: 'Steak',
          quantity: '2',
          price: '20.00',
          total: '46.00',
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
          option_quantity: 2,
          option_price: '3.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      expect(data.subtotal).toBe(46);
      expect(data.items[0].total).toBe(46);
    });
  });

  describe('No options (simple product)', () => {
    it('should use product total directly', async () => {
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

      expect(data.subtotal).toBe(50);
      expect(data.items[0].total).toBe(50);
    });
  });

  describe('Mixed products in same order', () => {
    it('should sum all product totals correctly', async () => {
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
          total: '12.00', // (5*2) + (1*2) = 12
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
          option_quantity: 3,
          option_price: '62.00',
        },
        {
          order_product_id: 401,
          option_name: 'Heat',
          option_value: 'Extra Hot',
          option_quantity: 2,
          option_price: '1.00',
        },
      ];

      const dataSource = createMockDataSource(orderProducts, options);
      const invoiceService = new InvoiceService(orderRepository, dataSource, s3Service, configService);
      const data = await invoiceService.fetchOrderData(1038);

      // Subtotal = $186 + $12 = $198
      expect(data.subtotal).toBe(198);
      expect(data.items[0].total).toBe(186);
      expect(data.items[1].total).toBe(12);
    });
  });
});
