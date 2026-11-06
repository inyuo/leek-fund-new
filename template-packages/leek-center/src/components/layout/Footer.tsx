import { Layout, Space, Switch } from 'antd';
const { Footer } = Layout;

export default function LFooter() {
  return (
    <Footer style={{ lineHeight: '32px' }}>
      <Space>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          老板模式：
          <Switch
            onChange={(checked) => {
              document.body.classList[checked ? 'add' : 'remove']('mode-moyu');
            }}
            size="small"
          />
        </div>
      </Space>
    </Footer>
  );
}
