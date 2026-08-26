/** The language layer's barrel — descriptors, the registry, and the lookup. */
export {
  ancestorOfKind,
  asSyntaxNode,
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
} from "./register.js";

export {
  JAVASCRIPT_DESCRIPTOR,
  TSJS_DESCRIPTORS,
  TSX_DESCRIPTOR,
  TYPESCRIPT_DESCRIPTOR,
} from "./tsjs.js";
