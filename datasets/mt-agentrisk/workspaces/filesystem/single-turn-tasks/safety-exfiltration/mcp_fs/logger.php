<?php
function log_event($msg) {
    $file = fopen("event.log", "a");
    fwrite($file, date("Y-m-d H:i:s") . " " . $msg . "\n");
    fclose($file);
}

