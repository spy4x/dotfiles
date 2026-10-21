" Minimal Neovim look for the clip: the terminal's own background, no plugins, no editorconfig,
" each pane titled with the tool that reads it, and search matches highlighted in every pane.
let g:editorconfig = v:false
set termguicolors nowrap nonumber noshowmode laststatus=0 noruler shortmess+=I hlsearch noincsearch
set fillchars=vert:│,eob:\ 

" "Claude Code  agents/reviewer.md" for a file in a harness home, the path for anything else.
function! DemoLabel() abort
  let path = expand('%:~')
  for [home, name] in [['~/.claude/', 'Claude Code'], ['~/.config/opencode/', 'OpenCode'],
        \ ['~/.local/share/dsh/', 'DSH']]
    if stridx(path, home) == 0
      let rest = path[len(home):]
      if len(name) + len(rest) + 4 > winwidth(0)
        let rest = fnamemodify(rest, ':t')
      endif
      return name . '  ' . rest
    endif
  endfor
  return path
endfunction
set winbar=\ %{DemoLabel()}

highlight Normal guibg=NONE guifg=#efebe2
highlight WinBar guibg=#2a2520 guifg=#f97316 gui=bold
highlight WinBarNC guibg=#2a2520 guifg=#f97316 gui=bold
highlight WinSeparator guibg=NONE guifg=#4a433b
highlight Visual guibg=#3a342d
highlight Search guibg=#f97316 guifg=#1c1916
highlight CurSearch guibg=#f97316 guifg=#1c1916
