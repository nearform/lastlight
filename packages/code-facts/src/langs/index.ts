/** The language layer's barrel — descriptors, the registry, and the lookup. */
export {
  ancestorOfKind,
  asSyntaxNode,
  grammarAvailable,
  interestingKinds,
  literalKindOf,
  supportedKinds,
} from "./descriptor.js";
export type {
  ConstantRule,
  DeclarationRule,
  LanguageDescriptor,
  LiteralKinds,
  SyntaxNode,
} from "./descriptor.js";

export {
  descriptorById,
  descriptorForPath,
  registeredExtensions,
  LANGUAGE_DESCRIPTORS,
  TSJS_FAMILY,
} from "./register.js";

export {
  DYNAMIC_GRAMMARS,
  forceGrammarUnavailable,
  grammarStatus,
  preflightLibrary,
} from "./dynamic.js";
export type { DynamicGrammar, GrammarStatus } from "./dynamic.js";

export { GO_DESCRIPTOR } from "./go.js";
export { JAVA_DESCRIPTOR } from "./java.js";
export { PYTHON_DESCRIPTOR } from "./python.js";

export {
  JAVASCRIPT_DESCRIPTOR,
  TSJS_DESCRIPTORS,
  TSX_DESCRIPTOR,
  TYPESCRIPT_DESCRIPTOR,
} from "./tsjs.js";
