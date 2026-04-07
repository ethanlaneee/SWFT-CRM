/**
 * Shared template resolution utility.
 * Replaces {{variable}} placeholders with values.
 */
function resolveTemplate(template, vars) {
  let msg = template || "";
  for (const [key, val] of Object.entries(vars)) {
    // Support both {{var}} and {var} syntax
    msg = msg.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val || "");
    msg = msg.replace(new RegExp(`\\{${key}\\}`, "g"), val || "");
  }
  return msg;
}

module.exports = { resolveTemplate };
