import json, os

SRC = r'D:\DevCache\temp\sakana-research-v016'
text = open(os.path.join(SRC, 'index.html'), encoding='utf-8', errors='replace').read()
BS = chr(92)
key = 'availableModels' + BS + '":'
i = text.find(key)
j = text.find('[', i + len(key))
# print a generous window so we can see the array and its true end
window = text[j:j + 2200]
open(os.path.join(SRC, 'raw_slice.txt'), 'w', encoding='utf-8').write(window)
print(window[:2000])
