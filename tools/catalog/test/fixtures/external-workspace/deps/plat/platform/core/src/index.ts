// This file must never be linted by the outer repo: it imports an undeclared package and escapes its root.
import { nope } from "@bsh/not-declared";
import { up } from "../../../secret";
export const core = { nope, up };
