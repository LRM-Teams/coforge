const noNativeTitle = {
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "title") {
          context.report({
            node,
            message: "Do not use the native title attribute; use the shared Tooltip component.",
          });
        }
      },
    };
  },
};

export default {
  meta: {
    name: "coforge",
  },
  rules: {
    "no-native-title": noNativeTitle,
  },
};
