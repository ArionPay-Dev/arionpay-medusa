import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import ArionPayProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [ArionPayProviderService],
})

export { ArionPayProviderService }
export type { ArionPayOptions } from "./service"
