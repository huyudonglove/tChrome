import Ajv2020 from "ajv/dist/2020.js";
import schema from "./data-schema.json";
import { identitySchema } from "../identity/catalog.ts";

// Reusable contract check for assembled logical module values; never rewrites data.
export const validateUserData = new Ajv2020({ allErrors: true, strict: false })
  .addSchema(identitySchema).compile(schema);
