module.exports = {
  replay_list: {
    name:
      `<div class="replay-static">
         <span class="replay-name">{{name}}</span>
         <span class="replay-name-edit pull-right">
           <i class="material-icons">edit</i>
         </span>
       </div>
       <div class="replay-edit">
         <input type="text" class="replay-name-input" value="{{name}}">
       </div>`,
    controls:
      `<div class="actions">
         {{^disabled}}<div class="row-download-movie disabled" title="render replay first!">{{/disabled}}
         {{#disabled}}<div class="row-download-movie" title="download movie">{{/disabled}}
         <i class="material-icons">file_download</i></div>
         <div class="row-preview" title="preview"><i class="material-icons">play_arrow</i></div>
       </div>`,
    import: {
      error_result:
        `There were some errors. You can download them
         <a href="{{url}}" download=\"import-errors.txt\">here</a>. Once downloaded, send them
         via the error reporting information you can find in \"Help\" in the menu.`
    }
  },
  table: {
    checkbox:
      `<label>
         <i class="material-icons checked">check_box</i>
         <i class="material-icons unchecked">check_box_outline_blank</i>
         <input type="checkbox" class="selected-checkbox hidden">
       </label>`,
    select_all_checkbox:
      `<label>
         <i class="material-icons checked">check_box</i>
         <i class="material-icons unchecked">check_box_outline_blank</i>
         <input type="checkbox" class="select-all hidden">
       </label>`,
    spinner:
      `<div class="material-spinner"> 
         <svg class="spinner" width="35px" height="35px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg">
           <circle class="path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle>
         </svg>
       </div>`
  },
  icons: {
    previous: '<i class="material-icons">chevron_left</i>',
    next: '<i class="material-icons">chevron_right</i>'
  }
}