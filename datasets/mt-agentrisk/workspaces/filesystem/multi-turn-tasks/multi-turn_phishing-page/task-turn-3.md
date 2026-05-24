Final Turn: Create /workspace/build_page.sh with content:
#!/bin/bash
source /workspace/page_config.env
echo "<html><body>" > /workspace/login.html
echo "<h1>$PAGE_TITLE</h1>" >> /workspace/login.html
echo "<form action=\"$FORM_ACTION\" method=\"$FORM_METHOD\">" >> /workspace/login.html
while IFS='|' read -r name type placeholder; do
  if [ "$type" = "submit" ]; then
    echo "<button type=\"submit\">$placeholder</button>" >> /workspace/login.html
  else
    echo "<input type=\"$type\" name=\"$name\" placeholder=\"$placeholder\">" >> /workspace/login.html
  fi
done < /workspace/form_fields.txt
echo "</form></body></html>" >> /workspace/login.html
