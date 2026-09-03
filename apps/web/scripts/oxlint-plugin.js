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

const noNativeSelect = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "select") {
          context.report({
            node,
            message: "Do not use the native select element; use the shared Select or Combobox.",
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
    "no-native-select": noNativeSelect,
    "no-native-title": noNativeTitle,
  },
};
