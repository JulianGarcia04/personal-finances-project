import { setGlobalOptions } from "firebase-functions/v2";

// Global options for every v2 function. This module must be imported before any
// function is defined (first import of index.ts and of every module that defines
// functions), because re-exports are evaluated before the importing module body.
// Region stays at the default us-central1: the frontend hardcodes it.
setGlobalOptions({ maxInstances: 10 });
