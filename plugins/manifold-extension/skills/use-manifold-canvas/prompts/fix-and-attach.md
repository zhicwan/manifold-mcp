# Using Fix and Attach explicitly

The Canvas workflow has two separate actions and it is important not to blur
them together:

- **Fix** sends the saved annotation batch directly as the model-edit request.
- **Attach** adds a pill to the composer and does not send the edit request.

## Rules of thumb

1. Use **Fix** when the user wants you to apply their notes to the current
   model.
2. Use **Attach** when the user wants to add supporting context, point at a
   region, or keep extra guidance with the next request.
3. Fix includes the complete saved snapshot in its message, not just a request
   that refers to an attachment.
4. Use the supplied snapshot instead of emulating MCP `get_annotations`.
5. Choose Fix or Attach for a batch. Fix does not consume other composer pills;
   to combine attached context with extra instructions, send the composer
   message manually.
