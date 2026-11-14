import { MAIN_PORT } from "../../support/hosts";
import { urlSpecs } from "../../support/urls";

// The default Worker: no PUBLIC_ORIGIN, no MINDBOX_ORIGIN. Every URL names the
// address the request came in on. (The same checks run against the configured
// Workers from e2e/origins/.)
const origin = `http://127.0.0.1:${MAIN_PORT}`;
urlSpecs("default origin", { app: origin, mindbox: origin });
