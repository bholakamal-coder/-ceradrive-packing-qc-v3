Ceradrive Packing QC v7.7.1 Sticker + Camera Hotfix

Complete full package with all required files included.

Fixed:
- Sticker Print option restored and visible after QC completion.
- STICKERS tab preserved for ADMIN/MANAGER/QC users.
- After SAVE ALL QC, app opens STICKERS page directly.
- QC completed party screen has PRINT STICKERS and QC PDF buttons.
- Direct red CAMERA button added for carton QC photo.
- Hidden file upload input; phone rear camera opens where browser/device supports capture=environment.
- Photo compression retained before save.
- API save logic changed to merge/replace records without deleting all orders/cartons first.
- QC save should not delete existing test orders.

Deploy:
1. Upload/replace all files in GitHub repo.
2. Cloudflare Pages will redeploy.
3. Test QC flow: packing -> QC -> camera -> save -> stickers.

Login defaults:
admin / Admin123
manager / Manager123
packing / Pack123
qc / Qc123


V7.7.2 HOTFIX:
- QC save persistence fixed with safe merge-save.
- QC photo is optional, not mandatory.
- Enter on Actual Weight moves to next carton instead of forcing photo.
- Camera button preserved; photos compressed smaller.
- Sticker print module preserved.


V7.7.9 HOTFIX:
- Current Order me inline Qty edit added.
- Part/SKU editing not added; wrong item should be deleted and re-added.
- Version labels updated to Ceradrive QC Packing App v7.7.9.
- Previous packing, QC, sticker, camera, history and icon logic preserved.
