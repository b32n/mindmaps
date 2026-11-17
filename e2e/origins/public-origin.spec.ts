import { originWorker } from "../support/hosts";
import { urlSpecs } from "../support/urls";

// PUBLIC_ORIGIN set (to a host other than the one the tests connect through),
// no MINDBOX_ORIGIN: app and mindbox links both use PUBLIC_ORIGIN.
urlSpecs("PUBLIC_ORIGIN", { app: originWorker.publicOrigin, mindbox: originWorker.publicOrigin });
