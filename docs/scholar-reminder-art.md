# Scholar reminder expressions

Generated with the built-in image-generation tool, using the existing Scholar 67 pose as the identity reference. Generated originals remain in the Codex image library. Project assets are resized and format-encoded without cropping or retouching. The app and push worker use the same versioned first-party assets.

The expression is selected from actual study activity: welcome for new students or private wording, celebration for an existing consecutive-day rhythm, and gentle encouragement for a return or a subject to revisit. It does not rotate randomly or claim an invented achievement.

Each notification supplies both a portrait icon and a larger image. Browser/OS support determines which options are displayed; rich images are not supported uniformly. See [MDN showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification). The test action updates the existing push worker before sending, while preserving the device subscription.

## welcome

Final assets: `client/public/pets/scholar/reminders/welcome-v1.jpg` (768×768) and `welcome-icon-v1.png` (192×192).

```text
Create a production illustration for PastQ study notifications. Reference image is the exact Scholar character identity: youthful student with warm light-medium skin, large expressive brown eyes, wavy dark brown hair, forest green varsity jacket with cream sleeves and striped collar, burgundy backpack straps. Preserve this exact character design and premium polished 3D animated-film rendering. Single centered close-up portrait, head and shoulders only, no hands in frame, complete hair with generous margin, eyes near the vertical center so notification crops retain the face. Square composition. Soft warm charcoal/forest-green studio background with subtle warm clay reflected light, clean, realistic materials, crisp eyes and facial anatomy, warm inviting lighting. No text, letters, logos, watermarks, icons, borders or notification UI. Expression: cheerful friendly welcome, open bright eyes and a natural small open smile, slightly lifted eyebrows, looking straight at the viewer. Warm and delighted, not exaggerated.
```

## focus

Final assets: `client/public/pets/scholar/reminders/focus-v1.jpg` (768×768) and `focus-icon-v1.png` (192×192).

```text
Create a production illustration for PastQ study notifications. Reference image is the exact Scholar character identity: youthful student with warm light-medium skin, large expressive brown eyes, wavy dark brown hair, forest green varsity jacket with cream sleeves and striped collar, burgundy backpack straps. Preserve this exact character design and premium polished 3D animated-film rendering. Single centered close-up portrait, head and shoulders only, no hands in frame, complete hair with generous margin, eyes near the vertical center so notification crops retain the face. Square composition. Soft warm charcoal/forest-green studio background with subtle warm clay reflected light, clean, realistic materials, crisp eyes and facial anatomy, warm inviting lighting. No text, letters, logos, watermarks, icons, borders or notification UI. Expression: gently attentive and encouraging, eyebrows slightly drawn in with a subtle caring half-smile, thoughtful warm eyes, slight head tilt. It says 'let's try together'. No sadness, guilt, aggression or tears.
```

## celebrate

Final assets: `client/public/pets/scholar/reminders/celebrate-v1.jpg` (768×768) and `celebrate-icon-v1.png` (192×192).

```text
Create a production illustration for PastQ study notifications. Reference image is the exact Scholar character identity: youthful student with warm light-medium skin, large expressive brown eyes, wavy dark brown hair, forest green varsity jacket with cream sleeves and striped collar, burgundy backpack straps. Preserve this exact character design and premium polished 3D animated-film rendering. Single centered close-up portrait, head and shoulders only, no hands in frame, complete hair with generous margin, eyes near the vertical center so notification crops retain the face. Square composition. Soft warm charcoal/forest-green studio background with subtle warm clay reflected light, clean, realistic materials, crisp eyes and facial anatomy, warm inviting lighting. No text, letters, logos, watermarks, icons, borders or notification UI. Expression: proud joyful celebration, beaming smile with natural teeth, softly lifted cheeks and happy sparkling eyes, a slight confident head tilt. Authentic delight without exaggerated distortion.
```
