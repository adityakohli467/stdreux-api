import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from "typeorm"
import { Company } from "./Company"
import { Department } from "./Department"
import { Order } from "./Order"

@Entity("customer")
@Index(["user_id"])
@Index(["company_id"])
@Index(["customer_type"])
@Index(["archived"])
export class Customer {
  @PrimaryGeneratedColumn()
  customer_id!: number

  @Column({ type: "int", nullable: true })
  user_id!: number

  @Column({ type: "varchar", length: 255, nullable: true })
  firstname!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  lastname!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  email!: string

  @Column({ type: "varchar", length: 50, nullable: true })
  telephone!: string

  @Column({ type: "text", nullable: true })
  customer_address!: string

  @Column({ type: "varchar", length: 100, nullable: true })
  customer_type!: string

  @Column({ type: "text", nullable: true })
  customer_notes!: string

  @Column({ type: "varchar", length: 100, nullable: true })
  customer_cost_centre!: string

  @Column({ type: "date", nullable: true })
  estimated_opening_date!: Date

  @Column({ type: "int", default: 1 })
  status!: number

  @Column({ type: "boolean", default: false })
  archived!: boolean

  @Column({ type: "boolean", default: false })
  pay_later!: boolean

  @Column({ type: "boolean", default: false })
  vip!: boolean

  @Column({ type: "int", nullable: true })
  company_id!: number

  @Column({ type: "int", nullable: true })
  department_id!: number

  @CreateDateColumn({ name: "customer_date_added" })
  customer_date_added!: Date

  @UpdateDateColumn({ name: "customer_date_modified" })
  customer_date_modified!: Date

  // Relations
  @ManyToOne(() => Company, (company) => company.customers)
  @JoinColumn({ name: "company_id" })
  company!: Company

  @ManyToOne(() => Department, (department) => department.customers)
  @JoinColumn({ name: "department_id" })
  department!: Department

  @OneToMany(() => Order, (order) => order.customer)
  orders!: Order[]
}

