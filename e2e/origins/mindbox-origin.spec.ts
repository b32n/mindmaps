import { mindboxWorker } from "../support/hosts";
import { urlSpecs } from "../support/urls";

// PUBLIC_ORIGIN, APP_ORIGIN and MINDBOX_ORIGIN set: app links on the app
// origin, signed frame and download links on the mindbox's.
urlSpecs("PUBLIC_ORIGIN + MINDBOX_ORIGIN", { app: mindboxWorker.publicOrigin, mindbox: mindboxWorker.mindboxOrigin });
