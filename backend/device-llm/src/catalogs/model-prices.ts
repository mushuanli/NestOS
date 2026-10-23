import source from './model-prices.json';
import type {ModelPriceCatalog} from '../contracts/model-price-catalog';

/** Reviewed vendor references are optional product data, outside the mechanism entry. */
export const MODEL_PRICE_CATALOG = source as ModelPriceCatalog;
