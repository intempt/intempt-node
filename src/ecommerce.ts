import type { Identifiers, ProductLine } from './types';
import { assertIdentifier, compact } from './utils';
import type { Ingest } from './ingest';

/**
 * Reserved event names the platform recognises for commerce reporting.
 * That is the only reason this namespace exists: it encodes the names so
 * callers cannot typo them, and it keeps the 1.x payload shape.
 */
export const COMMERCE_EVENTS = {
  productViewed: 'Product viewed',
  addedToCart: 'Added to cart',
  ordered: 'Product ordered',
} as const;

export class Ecommerce {
  readonly #ingest: Ingest;

  constructor(ingest: Ingest) {
    this.#ingest = ingest;
  }

  async productViewed(options: Identifiers & { productId: string }): Promise<void> {
    if (!options?.productId) {
      throw new TypeError('productViewed: productId is required');
    }
    assertIdentifier(options, 'productViewed');
    const { productId, ...ids } = options;
    await this.#ingest.trackLines(COMMERCE_EVENTS.productViewed, ids, [{ productId }]);
  }

  async addedToCart(
    options: Identifiers & { productId: string; quantity: number },
  ): Promise<void> {
    if (!options?.productId) {
      throw new TypeError('addedToCart: productId is required');
    }
    if (!Number.isFinite(options.quantity) || options.quantity <= 0) {
      throw new TypeError('addedToCart: quantity must be a positive number');
    }
    assertIdentifier(options, 'addedToCart');
    const { productId, quantity, ...ids } = options;
    await this.#ingest.trackLines(COMMERCE_EVENTS.addedToCart, ids, [{ productId, quantity }]);
  }

  async ordered(options: Identifiers & { products: ProductLine[] }): Promise<void> {
    if (!Array.isArray(options?.products) || options.products.length === 0) {
      throw new TypeError('ordered: products must be a non-empty array');
    }
    options.products.forEach((product, index) => {
      if (!product?.productId) {
        throw new TypeError(`ordered: products[${index}].productId is required`);
      }
      if (
        product.quantity !== undefined &&
        (!Number.isFinite(product.quantity) || product.quantity <= 0)
      ) {
        throw new TypeError(`ordered: products[${index}].quantity must be a positive number`);
      }
    });
    assertIdentifier(options, 'ordered');

    const { products, ...ids } = options;
    await this.#ingest.trackLines(
      COMMERCE_EVENTS.ordered,
      ids,
      products.map((product) => compact({ ...product })),
    );
  }
}
