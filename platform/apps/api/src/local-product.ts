import { startRegisteredLocalProduct } from './local-product-v0'

/** Start the deployment-registered local POC Core host. */
export async function startLocalProduct(): Promise<{ close(): Promise<void>; origin: string }> {
  return startRegisteredLocalProduct()
}
