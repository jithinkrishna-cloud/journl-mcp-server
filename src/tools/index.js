// Registers every read-only JournL tool. Write tools are out of scope.

import { registerCompanyTools } from "./companies/index.js";
import { registerLedgerTools } from "./ledgers/index.js";
import { registerReportTools } from "./reports/index.js";
import { registerStatementTools } from "./statements/index.js";
import { registerVoucherTools } from "./vouchers/index.js";
import { registerGstTools } from "./gst/index.js";
import { registerInventoryTools } from "./inventory/index.js";
import { registerCustomerTools } from "./customers/index.js";

export function registerTools(server) {
  registerCompanyTools(server);
  registerLedgerTools(server);
  registerReportTools(server);
  registerStatementTools(server);
  registerVoucherTools(server);
  registerGstTools(server);
  registerInventoryTools(server);
  registerCustomerTools(server);
}
