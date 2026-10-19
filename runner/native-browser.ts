import type { NativeOptions } from "./native";

// The tools each kind of turn may use in this conversation's browser, and
// how its pinned MCP server starts.
export const browserTools = (readOnly: boolean) => [
  // Navigation/waiting return accessibility snapshots without accepting a
  // filename. Standalone capture tools can write named files in MCP roots, so
  // they belong only to change children, never the read-only coordinator.
  "browser_navigate",
  "browser_wait_for",
  ...(!readOnly
    ? [
        "browser_snapshot",
        "browser_take_screenshot",
        "browser_console_messages",
        "browser_network_requests",
        "browser_click",
        "browser_type",
        "browser_fill_form",
        "browser_press_key",
        "browser_select_option",
        "browser_hover",
        "browser_drag",
        "browser_resize",
        "browser_navigate_back",
      ]
    : []),
];
// Claude's allowedTools grants permission but does not hide other MCP tools.
// Keep the pinned provider's unapproved tools out of the model's context, too.
const browserToolNames =
  "browser_click browser_close browser_console_messages browser_drag browser_drop browser_emulate_media browser_evaluate browser_file_upload browser_fill_form browser_find browser_handle_dialog browser_hover browser_navigate browser_navigate_back browser_network_request browser_network_requests browser_press_key browser_resize browser_run_code_unsafe browser_select_option browser_snapshot browser_take_screenshot browser_type browser_wait_for browser_tabs browser_get_config browser_network_state_set browser_route browser_route_list browser_unroute browser_cookie_clear browser_cookie_delete browser_cookie_get browser_cookie_list browser_cookie_set browser_localstorage_clear browser_localstorage_delete browser_localstorage_get browser_localstorage_list browser_localstorage_set browser_sessionstorage_clear browser_sessionstorage_delete browser_sessionstorage_get browser_sessionstorage_list browser_sessionstorage_set browser_set_storage_state browser_storage_state browser_annotate browser_hide_highlight browser_highlight browser_resume browser_start_recording browser_start_tracing browser_start_video browser_stop_recording browser_stop_tracing browser_stop_video browser_video_chapter browser_video_hide_actions browser_video_show_actions browser_mouse_click_xy browser_mouse_down browser_mouse_drag_xy browser_mouse_move_xy browser_mouse_up browser_mouse_wheel browser_pdf_save browser_generate_locator browser_verify_element_visible browser_verify_list_visible browser_verify_text_visible browser_verify_value".split(
    " ",
  );
export const hiddenBrowserTools = (readOnly: boolean) =>
  browserToolNames.filter((tool) => !browserTools(readOnly).includes(tool));
export const browserArgs = (o: NativeOptions) => [
  "-y",
  "@playwright/mcp@0.0.83",
  "--output-dir",
  o.browser!.outputDir,
  "--output-max-size",
  "50000000",
  "--no-webmcp",
  "--codegen",
  "none",
];
