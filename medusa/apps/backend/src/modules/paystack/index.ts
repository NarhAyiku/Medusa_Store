import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { PaystackProviderService } from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [PaystackProviderService],
})
